// node test/watchdog.test.mjs
// The night agent's contract, tested against a fake D1. The point of these is
// that a check which silently stops finding things is indistinguishable from a
// healthy system, so each one is pinned.

import { runWatchdog, ELIGIBLE_MOT_SQL, AZAMARA_MAX_SILENCE_DAYS } from '../src/lib/watchdog.js';
import assert from 'node:assert';

// Minimal D1 stand-in: matches on a distinctive fragment of each query.
function fakeDb(responses, log = []) {
  const pick = (sql) => {
    for (const [frag, val] of responses) if (sql.includes(frag)) return val;
    return null;
  };
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { const v = pick(sql); return Array.isArray(v) ? v[0] : v; },
        async all() { const v = pick(sql); return { results: Array.isArray(v) ? v : (v ? [v] : []) }; },
        // The whole statement, not a 60-character prefix: the scoping bugs this
        // file pins live in the WHERE clause and the subquery, not the first line.
        async run() { log.push(sql.replace(/\s+/g, ' ').trim()); return {}; },
      };
    },
  };
}

const TODAY = '2026-09-10';

// A consumption series that is boring on purpose: the anomaly check must find
// nothing in it, so any finding in the "clean" case below is a real regression.
const flatConsumption = ['09-01','09-02','09-03','09-04','09-05','09-06','09-07']
  .map((d) => ({ ship: 'Summit', item: 'TONER TN-514K BLACK', date: `2026-${d}`, value: 12 }));

const base = [
  ['MAX(snapshot_date) inv', { inv: '2026-09-10', it: '2026-09-10' }],
  ['SUM(CASE WHEN eta GLOB', { n: 2204, bad: 0 }],
  ['WHERE NOT (', []],
  ["'azamara-mls:prev'", { n: 0 }],
  ['HAVING COUNT(*) > 1', []],
  ['MAX(loading_delivery_date) last_load', [{ ship: 'Summit', last_load: '2027-03-28', rows_: 29 }]],
  ['COUNT(DISTINCT ship) n FROM par', { n: 48 }],
  ["note LIKE 'weekly run%'", { ts: '2026-09-08 12:00:00' }],
  ["sender = 'cron' AND note LIKE '%send%'", { ts: '2026-09-08 12:00:00' }],
  ['%FAILED%', []],
  ['Azamara MLS REFUSED%', []],
  // The mail route. In the clean fixture an MLS arrived recently and mail is
  // reaching the Worker, so check 9 stays quiet.
  ["note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'", { ts: '2026-09-01 08:00:00' }],
  ["sender NOT IN ('cron', 'watchdog')", { n: 6, ts: '2026-09-01 08:00:00' }],
  // The ship-name join. Both sides spell Summit the same way, so nothing is
  // unmatched and the check stays quiet.
  ['DISTINCT ship FROM schedule_order', [{ ship: 'Summit' }]],
  ['DISTINCT ship FROM obp_intransit', [{ ship: 'Summit' }]],
  ['WITH eligible AS', []],
  // Column probes. A probe that comes back empty means the check CANNOT RUN,
  // which is reported - never treated as a clean result.
  ['PRAGMA table_info(obp_intransit)',
    ['ship', 'eta', 'snapshot_date', 'item_description', 'qty'].map((name) => ({ name }))],
  ['PRAGMA table_info(consumption_snapshot)',
    ['ship', 'item', 'snapshot_date', 'on_hand'].map((name) => ({ name }))],
  ['FROM consumption_snapshot', flatConsumption.map((r) => ({ ...r }))],
];
const withRow = (frag, val) => base.map(([f, v]) => (f === frag ? [f, val] : [f, v]));

// A stale feed is the failure that makes every other number a lie.
const stale = await runWatchdog(
  { HON: fakeDb(withRow('MAX(snapshot_date) inv', { inv: '2026-09-04', it: '2026-09-04' })) },
  TODAY, { repair: false });
assert.equal(stale.counts.critical, 2, 'a 6-day-old feed must be critical on both tables');

// Export format drift: eta stops being an Excel serial and every date match dies.
const drift = await runWatchdog(
  { HON: fakeDb(withRow('SUM(CASE WHEN eta GLOB', { n: 2204, bad: 2204 })) },
  TODAY, { repair: false });
assert.ok(drift.findings.some((f) => f.check === 'eta_format'), 'eta format drift must be caught');

// Out-of-scope rows WE wrote are repaired. Rows another app wrote are reported
// and LEFT ALONE - a watchdog that quietly deletes a neighbour's data is worse
// than the problem it solves. The live database had exactly this case: 10
// Symphony rows written by cims-hon's own ingest, source 'email'.
const log = [];
const scoped = await runWatchdog(
  { HON: fakeDb(withRow('WHERE NOT (', [
    { mot: 'WINE', source: 'ordering-schedule', n: 40 },
    { mot: 'MEDICAL', source: 'email', n: 12 },
  ]), log) },
  TODAY, { repair: true });
assert.ok(scoped.repairs.some((r) => r.includes('40 out-of-scope')), 'must repair only our own 40 rows');
assert.ok(log.some((s) => s.startsWith('DELETE FROM schedule_order')), 'must actually delete');
assert.ok(scoped.findings.some((f) => f.check === 'scope' && f.detail.includes('NOT touched')),
  "another app's 12 rows must be reported, never deleted");

// THE BUG THAT WOULD HAVE DESTROYED DATA. Symphony's schedule carries
// "HOTEL BIWEEKLY - HOTEL". The old normaliser turned the hyphen into a space,
// left a DOUBLE space, failed the LIKE, and classified all 10 of Symphony's
// real voyages as out-of-scope - which the repair step would then have deleted.
const squash = (m) => m.toUpperCase().replace(/-/g, '').replace(/ /g, '');
for (const mot of ['HOTEL BIWEEKLY HOTEL', 'HOTEL BIWEEKLY - HOTEL', 'HOTEL BIWEEKLY - HOTEL ',
                   'HOTEL MONTHLY', 'HOTEL MONTHLY LOCAL']) {
  assert.ok(squash(mot).startsWith('HOTELBIWEEKLYHOTEL') || squash(mot).startsWith('HOTELMONTHLY'),
    `"${mot}" must be recognised as ours`);
}
for (const mot of ['HOTEL BIWEEKLY FOOD', 'HOTEL WEEKLY HOTEL', 'WINE', 'PHOTO MONTHLY']) {
  assert.ok(!squash(mot).startsWith('HOTELBIWEEKLYHOTEL') && !squash(mot).startsWith('HOTELMONTHLY'),
    `"${mot}" must NOT be treated as ours`);
}
assert.ok(ELIGIBLE_MOT_SQL.includes("REPLACE(REPLACE(mot,'-',''),' ','')"),
  'the SQL must squash hyphens AND spaces, not swap hyphens for spaces');

// A ship whose schedule has run out is invisible to the weekly check - the
// worst state, because it looks identical to a ship with nothing due.
const expired = await runWatchdog(
  { HON: fakeDb(withRow('MAX(loading_delivery_date) last_load',
    [{ ship: 'Odyssey', last_load: '2026-08-01', rows_: 11 }])) },
  TODAY, { repair: false });
assert.ok(expired.findings.some((f) => f.check === 'schedule_expired'), 'expired schedule must be critical');

// THE OTHER BUG THAT WOULD HAVE DESTROYED DATA. The de-dupe repair's DELETE
// had no scope: its subquery grouped over the WHOLE table, so a duplicate among
// OUR rows de-duplicated every other MOT and every other app's rows too.
const dlog = [];
await runWatchdog(
  { HON: fakeDb(withRow('HAVING COUNT(*) > 1',
    [{ ship: 'Journey', voyage: null, mot: 'AZAMARA BWS', due_date: '2026-10-02', n: 2 }]), dlog) },
  TODAY, { repair: true });
const del = dlog.find((q) => q.startsWith('DELETE FROM schedule_order') && q.includes('id NOT IN'));
assert.ok(del, 'the de-dupe repair must still run');
const fullDelete = dlog.filter((q) => q.startsWith('DELETE FROM schedule_order'));
for (const q of fullDelete) {
  assert.ok(!/DELETE FROM schedule_order WHERE id NOT IN/.test(q),
    'the de-dupe DELETE must never be unscoped - it would reach other apps rows');
}

// Ships whose name does not match between the schedule and OBP read as MISSING
// EVERYTHING, confidently and forever, because the whole ordered test is that
// join. Silence there is the most expensive kind.
const join = await runWatchdog(
  { HON: fakeDb(withRow('DISTINCT ship FROM obp_intransit', [{ ship: 'Allure of the Seas' }])
      .map(([f, v]) => (f === 'DISTINCT ship FROM schedule_order' ? [f, [{ ship: 'Odyssey' }]] : [f, v]))) },
  TODAY, { repair: false });
assert.ok(join.findings.some((f) => f.check === 'ship_join'),
  'a schedule ship with no OBP name match must be reported');

// A weekly cron that stops firing looks exactly like a quiet week. It must not.
const silent = await runWatchdog(
  { HON: fakeDb(withRow("note LIKE 'weekly run%'", { ts: null })) }, TODAY, { repair: false });
assert.ok(silent.findings.some((f) => f.check === 'weekly_silent'),
  'a weekly email that has never run must be reported');

// A check that cannot read its columns must say CANNOT RUN, never come back
// empty and be read as healthy.
const blind = await runWatchdog(
  { HON: fakeDb(withRow('PRAGMA table_info(consumption_snapshot)', [])) }, TODAY, { repair: false });
assert.ok(blind.findings.some((f) => f.check === 'anomaly_blocked'),
  'a missing table must be reported as blocked, not as clean');

// THE ROUTE THAT NEVER EXISTED. On 10 Sep 2026 Ray's MLS bounced with
// 550 5.1.1 "Address does not exist": azamara@cims.work had no Email Routing
// rule, so no mail ever reached this Worker. Every check was clean and /health
// showed 14 azamara-mls rows, because those had been loaded by another path.
// A feed that has NEVER delivered must not read as a feed with nothing to say.
const noRoute = await runWatchdog(
  { HON: fakeDb(withRow("sender NOT IN ('cron', 'watchdog')", { n: 0, ts: null })
      .map(([f, v]) => (f === "note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'" ? [f, { ts: null }] : [f, v]))) },
  TODAY, { repair: false });
const route = noRoute.findings.find((f) => f.check === 'mail_route');
assert.ok(route, 'a Worker that has never received mail must say so');
assert.equal(route.severity, 'critical');
assert.ok(/azamara@cims\.work/.test(route.detail),
  'the finding must name the address whose route is missing, not just "no mail"');

// A DIFFERENT FAULT WITH THE SAME SYMPTOM. Mail is arriving and none of it
// parses as an MLS: the route is fine and the identity test or the format is
// not. Telling Miguel to go fix a Cloudflare rule here would waste the day.
const noMls = await runWatchdog(
  { HON: fakeDb(withRow("note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'", { ts: null })) }, TODAY, { repair: false });
const parse = noMls.findings.find((f) => f.check === 'mail_route');
assert.ok(parse, 'mail that never parses as an MLS must be reported');
assert.ok(!/Email Routing/.test(parse.detail),
  'this case must NOT blame the route - mail is arriving');
assert.ok(/ingest_log/.test(parse.detail), 'it must point at the rejected-mail log');

// Ray publishes monthly. Silence past that window is the feed stopping.
const staleMls = await runWatchdog(
  { HON: fakeDb(withRow("note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'", { ts: '2026-06-01 08:00:00' })) },
  TODAY, { repair: false });
assert.ok(staleMls.findings.some((f) => f.check === 'mail_route' && f.detail.includes('101 days ago')),
  'an MLS that stopped arriving must be reported with its age');

// ...and a publication inside the window is silence, not a finding. A check
// that fires on a healthy month is filtered within two.
const freshMls = await runWatchdog(
  { HON: fakeDb(withRow("note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'",
    { ts: '2026-08-20 08:00:00' })) }, TODAY, { repair: false });
assert.ok(!freshMls.findings.some((f) => f.check === 'mail_route'),
  `${AZAMARA_MAX_SILENCE_DAYS} days is the window, and 21 is inside it`);

// Clean is clean: only the coverage warning, no criticals, nothing repaired.
const clean = await runWatchdog({ HON: fakeDb(base) }, TODAY, { repair: false });
assert.equal(clean.findings.length, 1,
  `only the 1-of-48 coverage warning is expected here, got: ${clean.findings.map((f) => f.check).join(', ')}`);
assert.equal(clean.counts.critical, 0);
assert.equal(clean.repairs.length, 0);

console.log('ok - watchdog catches stale feed, format drift, scope leaks and expired schedules,');
console.log('     repairs only its own rows, and recognises the hyphenated MOT variant');

// ---- Memory: a finding is mailed the night it appears, then goes quiet ----
// Miguel emptied WATCHDOG_TO on 10 Sep 2026 because a stateless check would
// repeat a standing condition nightly until it was filtered. The feed freeze of
// 10-16 Sep was then detected every night and told nobody. Memory is the fix:
// new once, quiet after, a weekly reminder while a critical stands.
{
  process.emitWarning = () => {};
  const { DatabaseSync } = await import('node:sqlite');
  const { rememberFindings, findingKey } = await import('../src/lib/watchdog.js');
  const db = new DatabaseSync(':memory:');
  const hon = {
    prepare(sql) {
      const binds = [];
      const stmt = {
        bind(...a) { binds.push(...a); return stmt; },
        async all() { return { results: db.prepare(sql).all(...binds) }; },
        async first() { return db.prepare(sql).get(...binds) ?? null; },
        async run() { return db.prepare(sql).run(...binds); },
      };
      return stmt;
    },
  };
  const frozen = (n) => ({ severity: 'critical', check: 'feed_frozen', detail: `obp_inventory content identical for ${n} consecutive snapshots (3482 rows, total 13990)` });
  const cover = { severity: 'warn', check: 'coverage', detail: '36 of 48 ships have an ordering schedule loaded' };
  assert.equal(findingKey(frozen(5)), findingKey(frozen(6)), 'a count that ticks up is the same finding, not a new one');

  const n1 = await rememberFindings(hon, { findings: [frozen(5), cover] }, '2026-09-11');
  assert.equal(n1.fresh.length, 2, 'night one: everything is new');
  const n2 = await rememberFindings(hon, { findings: [frozen(6), cover] }, '2026-09-12');
  assert.equal(n2.fresh.length, 0, 'night two: nothing new, nothing to mail');
  assert.equal(n2.standing.length, 2);
  assert.equal(n2.reminders.length, 0);
  const n8 = await rememberFindings(hon, { findings: [frozen(12), cover] }, '2026-09-18');
  assert.equal(n8.fresh.length, 0);
  assert.equal(n8.reminders.length, 1, 'a critical still standing after seven days is mentioned again');
  assert.equal(n8.reminders[0].check, 'feed_frozen', 'the warn is not');
  const n9 = await rememberFindings(hon, { findings: [frozen(13), cover, { severity: 'critical', check: 'delivery', detail: 'Apex: 1 order due -> ax@x: bounced' }] }, '2026-09-19');
  assert.equal(n9.fresh.length, 1, 'a genuinely new finding is new');
  assert.equal(n9.fresh[0].check, 'delivery');
  console.log('ok - watchdog memory: new once, quiet after, a weekly reminder only while a critical stands');
}

// REVIEW OF 17 Sep 2026: a finding that grows from warn to critical is news,
// and a reminder counts from the last time it was mailed, so one missed night
// cannot skip a week.
{
  const { DatabaseSync } = await import('node:sqlite');
  const { rememberFindings } = await import('../src/lib/watchdog.js');
  const db = new DatabaseSync(':memory:');
  const hon = {
    prepare(sql) {
      const binds = [];
      const stmt = {
        bind(...a) { binds.push(...a); return stmt; },
        async all() { return { results: db.prepare(sql).all(...binds) }; },
        async first() { return db.prepare(sql).get(...binds) ?? null; },
        async run() { return db.prepare(sql).run(...binds); },
      };
      return stmt;
    },
  };
  const feed = (sev, days) => ({ severity: sev, check: 'feed', detail: `obp_inventory last snapshot 2026-09-19, ${days} days old` });
  const d1 = await rememberFindings(hon, { findings: [feed('warn', 2)] }, '2026-09-21');
  assert.equal(d1.fresh.length, 1);
  const d2 = await rememberFindings(hon, { findings: [feed('warn', 3)] }, '2026-09-22');
  assert.equal(d2.fresh.length, 0, 'same warning, same finding');
  const d3 = await rememberFindings(hon, { findings: [feed('critical', 4)] }, '2026-09-23');
  assert.equal(d3.fresh.length, 1, 'warn -> critical is mailed as new');
  assert.ok(d3.fresh[0].escalated, 'and marked as an escalation');
  const d4 = await rememberFindings(hon, { findings: [feed('critical', 5)] }, '2026-09-24');
  assert.equal(d4.fresh.length, 0);
  assert.equal(d4.reminders.length, 0);
  // Night 7 after the escalation mail (09-30) is missed entirely; night 8 must still remind.
  const d8 = await rememberFindings(hon, { findings: [feed('critical', 12)] }, '2026-10-01');
  assert.equal(d8.reminders.length, 1, 'eight days after the last mail: reminded, not skipped to day 14');
  const d9 = await rememberFindings(hon, { findings: [feed('critical', 13)] }, '2026-10-02');
  assert.equal(d9.reminders.length, 0, 'and not again the next night');
  console.log('ok - watchdog memory: an escalation is news; reminders count from the last mail');
}

// ---- Delivery: Monday's emails are checked against cims-mail's log ----
{
  const mailRows = [
    { to_json: '["ax_printer@celebrity.com"]', subject: 'Apex: 1 order due', status: 'sent', delivery_status: 'bounced', delivery_detail: '550 no such user', created_at: '2026-09-07 12:00:10' },
    { to_json: '["qs_pm@azamaraships.com"]', subject: 'Quest: 3 running out', status: 'sent', delivery_status: 'delayed', delivery_detail: null, created_at: '2026-09-07 12:00:11' },
    { to_json: '["an_printerspecialist@rccl.com"]', subject: 'Anthem: 1 order due', status: 'sent', delivery_status: 'delivered', delivery_detail: null, created_at: '2026-09-07 12:00:12' },
  ];
  const MAIL = fakeDb([['FROM mail_log', mailRows]]);
  const r = await runWatchdog({ HON: fakeDb(base), MAIL }, TODAY, { repair: false });
  const del = r.findings.filter((f) => f.check === 'delivery');
  assert.equal(del.length, 2, `one bounce and one delay: ${JSON.stringify(del)}`);
  assert.ok(del.some((f) => f.severity === 'critical' && /Apex/.test(f.detail) && /bounced/.test(f.detail)), 'a bounce is critical and names the ship');
  assert.ok(del.some((f) => f.severity === 'warn' && /Quest/.test(f.detail)), 'a delay is a warning');
  assert.ok(!del.some((f) => /Anthem/.test(f.detail)), 'a delivered email is not mentioned');
  assert.equal(r.counts.delivery, '3 weekly emails checked');
  const none = await runWatchdog({ HON: fakeDb(base) }, TODAY, { repair: false });
  assert.equal(none.counts.delivery, 'no MAIL binding', 'without the binding the check says it cannot run');
  console.log('ok - watchdog delivery: a bounced Monday email is critical, a delay is a warning, delivered is silent');
}
