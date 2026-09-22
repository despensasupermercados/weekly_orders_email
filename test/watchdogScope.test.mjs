// ingest_log IS SHARED WITH cims-hon, AND OUR READS MUST SAY SO.
//
// 22 Sep 2026, the morning after cims-hon deployed the inbox sweeper we
// specified for it. The sweeper writes sender='cron' and "swept 1: 1 done,
// 0 failed"; our send-failure check was `note LIKE '%FAILED%'` with no source
// filter, and SQLite's LIKE is case-insensitive — so another application's row
// reporting ZERO failures raised a CRITICAL against a send of ours.
//
// The guard below asserts the RULE, not that one bug: every read of the shared
// table, in every file, is scoped. It counts occurrences and requires each one
// to be accounted for, because the first version of this guard matched with a
// 200-character window and SILENTLY SKIPPED anything longer — a guard that can
// fail to match is not a guard, and /health's unscoped MLS read survived it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { INGEST_SOURCE } from '../src/lib/watchdog.js';
import { SEND_FAILED_MARK, onDemandOutcome, sendFailure, sendThrew } from '../src/lib/sendNote.js';

const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const FILES = ['lib/watchdog.js', 'index.js'];

// ---- the rule: every read of the shared table is scoped -------------------
for (const f of FILES) {
  const src = read(f);
  const occurrences = (src.match(/FROM ingest_log/g) || []).length;
  // Pull whole string literals (backtick or double-quoted) and keep the ones
  // that read the table. If these two counts disagree, a read exists that this
  // guard could not see — which is the failure mode that let /health through.
  // Scan with positions, not indexOf. The first version looked each literal up
  // with `src.indexOf(l)`, which returns the FIRST occurrence — so two
  // identical queries would both be checked against the first one's .bind(),
  // a guard pointing at the wrong text, which is the very fault this file
  // exists to catch.
  const literals = [];
  for (const m of src.matchAll(/`[^`]*`|"[^"\n]*"/g)) {
    if (/FROM ingest_log/.test(m[0])) literals.push({ text: m[0], end: m.index + m[0].length });
  }
  const seen = literals.reduce((n, l) => n + (l.text.match(/FROM ingest_log/g) || []).length, 0);
  assert.equal(seen, occurrences,
    `${f}: found ${occurrences} reads of ingest_log but could only inspect ${seen} — the guard is blind to one`);
  for (const { text: l, end } of literals) {
    // Two legitimate spellings, and the guard must know both. Interpolated
    // (`source = '${INGEST_SOURCE}'`) is the common one; the once-per-Monday
    // guard binds it as a parameter instead. A bare `source = ?1` proves
    // nothing on its own, so for that form require the binding right after the
    // literal to name INGEST_SOURCE — otherwise a query could scope itself to
    // any value at all and still pass.
    const interpolated = /source\s*=\s*'\$\{INGEST_SOURCE\}'/.test(l);
    const bound = /source\s*=\s*\?\d*/.test(l)
      && /\.bind\(\s*INGEST_SOURCE\b/.test(src.slice(end, end + 200));
    assert.ok(interpolated || bound,
      `${f}: every ingest_log read must filter on source — this one does not:\n${l}`);
  }
  assert.ok(occurrences > 0, `${f}: expected at least one ingest_log read`);
}

// ---- the writer and the reader share one marker ---------------------------
// They drifted twice. The SQL is built from the same constant the note is.
assert.ok(read('lib/watchdog.js').includes('${SEND_FAILED_MARK}'),
  'the send-failure query must be built from the shared marker, not a copy of it');

// ---- every real outcome this project writes -------------------------------
// A throw before the loop is a failure. "nothing to send" is the healthiest
// outcome a chase has. They used to print the same word.
const thrown = onDemandOutcome({ lines: [], result: { sent: false, threw: "unknown kind 'weekley'" } });
const quiet = onDemandOutcome({ lines: [], result: { sent: false, reason: 'nothing to send: no ship is missing its Ordering Schedule' } });
const ok = onDemandOutcome({ lines: [], result: { sent: true } });
const perShip = onDemandOutcome({ lines: ['Journey -> jr@x.com: sent'], result: { sent: true } });
const mystery = onDemandOutcome({ lines: [], result: { sent: false } });

assert.ok(thrown.includes(SEND_FAILED_MARK), 'a throw before the loop is a send failure');
assert.ok(!quiet.includes(SEND_FAILED_MARK), '"nothing to send" is NOT a failure — it raised a critical on every quiet chase');
assert.match(quiet, /nothing to do/);
assert.ok(!ok.includes(SEND_FAILED_MARK) && ok === 'sent');
assert.match(perShip, /Journey/);
assert.ok(mystery.includes(SEND_FAILED_MARK), 'a non-send we cannot explain is treated as a failure, not as quiet');

// ---- EVERY way this project can fail to send carries the mark -------------
// Measured 22 Sep: the night check could see FOUR of EIGHT failure shapes.
// The three `send THREW:` sites — which is how a transport exception actually
// surfaces — and the per-ship `NOT SENT` line were all invisible to it.
const everyFailure = [
  ['digest returned not-sent', sendFailure('digest', { status: 500 })],
  ['digest threw', sendThrew('digest', new Error('fetch failed'))],
  ['weekly returned not-sent', sendFailure('weekly', { status: 500 })],
  ['weekly threw', sendThrew('weekly', new Error('binding unavailable'))],
  ['weekly per-ship failure', sendFailure('weekly', 'Journey -> jr@x.com')],
  ['supervisor returned not-sent', sendFailure('weekly supervisor', { status: 500 })],
  ['supervisor threw', sendThrew('weekly supervisor', new Error('timeout'))],
  ['on-demand per-ship NOT SENT', onDemandOutcome({
    lines: ['Journey -> jr@x.com: NOT SENT {"status":500}'], result: { sent: false } })],
  ['on-demand throw before the loop', thrown],
];
for (const [label, note] of everyFailure) {
  assert.ok(note.includes(SEND_FAILED_MARK), `${label} must carry the failure mark: ${note}`);
}
// And no source file writes a failure note by hand any more.
for (const f of ['index.js']) {
  const src2 = read(f);
  assert.ok(!/send THREW:/.test(src2), `${f}: "send THREW:" must go through sendThrew(), not a literal`);
  assert.ok(!/`[^`]*send FAILED:/.test(src2), `${f}: a hand-written "send FAILED:" can drift from the reader`);
}

// ---- and the query actually catches them ----------------------------------
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE ingest_log (ts TEXT, source TEXT, sender TEXT, note TEXT)');
const row = (source, sender, note) =>
  db.prepare('INSERT INTO ingest_log VALUES (?,?,?,?)').run('2026-09-22 06:00:00', source, sender, note);

row('cims-hon', 'cron', 'swept 1: 1 done, 0 failed');                  // theirs
row('inbox', 'cron', 'swept 3: 2 done, 1 failed');                     // theirs, a real failure of THEIRS
row(INGEST_SOURCE, 'cron', 'weekly fleet send: 13 of 13 ships mailed');// ours, healthy
row(INGEST_SOURCE, 'cron', `on-demand weekly send #12 Journey: ${thrown}`); // ours, the one that was silenced
row(INGEST_SOURCE, 'cron', `on-demand chase send #13 *: ${quiet}`);    // ours, healthy
row(INGEST_SOURCE, 'watchdog', sendThrew('digest', new Error('fetch failed'))); // ours, never caught before
row(INGEST_SOURCE, 'cron', `on-demand weekly send #14 Star: ${onDemandOutcome({ lines: ['Star -> st@x.com: NOT SENT {"status":500}'], result: { sent: false } })}`);

const m = read('lib/watchdog.js').match(/`SELECT ts, note FROM ingest_log\s*\n\s*WHERE source[\s\S]*?ORDER BY ts DESC LIMIT 5`/);
assert.ok(m, 'could not locate the send-failure query in watchdog.js');
const sql = m[0].slice(1, -1)
  .replaceAll('${INGEST_SOURCE}', INGEST_SOURCE)
  .replaceAll('${SEND_FAILED_MARK}', SEND_FAILED_MARK);
const got = db.prepare(sql).all('2026-09-23').map((r) => r.note);

assert.equal(got.length, 3, `expected our three real failures, got ${JSON.stringify(got)}`);
assert.ok(got.some((n) => /on-demand weekly send #12/.test(n)), 'the on-demand throw must be caught');
assert.ok(got.some((n) => /^digest/.test(n)), "the night check's own digest failure must be caught");
assert.ok(got.some((n) => /#14 Star/.test(n)), 'a per-ship transport failure on an on-demand send must be caught');
assert.ok(!got.some((n) => /swept/.test(n)), "another app's sweeper is never our send failure");
assert.ok(!got.some((n) => /nothing to do/.test(n)), 'a quiet chase is never a send failure');

console.log('ok - shared table: every ingest_log read is scoped and visible to this guard; the failure marker is shared by writer and reader; a throw and a quiet chase are told apart');
