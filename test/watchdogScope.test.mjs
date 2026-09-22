// ingest_log IS SHARED WITH cims-hon, AND FIVE OF OUR SIX READS DID NOT SAY SO.
//
// 22 Sep 2026, the morning after cims-hon deployed the store-then-process inbox
// sweeper we specified for it. The sweeper writes sender='cron' and the note
// "swept 1: 1 done, 0 failed". Our send-failure check was
// `note LIKE '%FAILED%'` with no source filter, and SQLite's LIKE is
// case-insensitive — so a row reporting ZERO failures, written by another
// application, raised a CRITICAL against a send of ours that never happened.
//
// This test reads the SQL out of the shipped source rather than restating it,
// so it cannot drift away from what actually runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { INGEST_SOURCE } from '../src/lib/watchdog.js';

const src = fs.readFileSync(new URL('../src/lib/watchdog.js', import.meta.url), 'utf8');

// Every read of the shared table must scope itself to our own rows. This is the
// rule, not the single bug: a check that reads another app's rows breaks every
// time that app ships anything.
const reads = src.match(/FROM ingest_log[\s\S]{0,200}?`/g) || [];
assert.ok(reads.length >= 6, `expected to find the ingest_log reads, found ${reads.length}`);
for (const r of reads) {
  assert.ok(/source\s*=\s*'\$\{INGEST_SOURCE\}'/.test(r),
    `every ingest_log read must filter on source — this one does not:\n${r}`);
}

// And the live regression, against the real query.
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, source TEXT, sender TEXT, note TEXT)`);
const row = (source, sender, note, ts = '2026-09-22 06:00:00') =>
  db.prepare(`INSERT INTO ingest_log (ts, source, sender, note) VALUES (?,?,?,?)`).run(ts, source, sender, note);

row('cims-hon', 'cron', 'swept 1: 1 done, 0 failed');          // theirs — must be ignored
row('inbox', 'cron', 'swept 3: 2 done, 1 failed');             // theirs, a real failure of THEIRS — still not ours
row(INGEST_SOURCE, 'cron', 'weekly fleet send: 13 of 13 ships mailed'); // ours, healthy
row(INGEST_SOURCE, 'cron', 'weekly send FAILED: {"status":500}');       // ours, a real failure

// Pull the shipped send-failure query out of the source and run it verbatim.
const m = src.match(/`SELECT ts, note FROM ingest_log\s*\n\s*WHERE source[\s\S]*?ORDER BY ts DESC LIMIT 5`/);
assert.ok(m, 'could not locate the send-failure query in watchdog.js');
const sql = m[0].slice(1, -1).replace('${INGEST_SOURCE}', INGEST_SOURCE);
const got = db.prepare(sql).all('2026-09-23');

assert.equal(got.length, 1, `exactly one failure is ours, got ${JSON.stringify(got)}`);
assert.match(got[0].note, /weekly send FAILED/, 'and it is the real one');
assert.ok(!got.some((r) => /swept/.test(r.note)), "cims-hon's sweeper must never raise send_failed");

console.log("ok - watchdog scope: every ingest_log read is scoped to our own rows, and another app's \"0 failed\" is not our send failure");
