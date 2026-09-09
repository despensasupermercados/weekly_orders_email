// node test/watchdog.test.mjs
// The night agent's contract, tested against a fake D1. The point of these is
// that a check which silently stops finding things is indistinguishable from a
// healthy system, so each one is pinned.

import { runWatchdog, ELIGIBLE_MOT_SQL } from '../src/lib/watchdog.js';
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
        async run() { log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60)); return {}; },
      };
    },
  };
}

const TODAY = '2026-09-10';
const base = [
  ['MAX(snapshot_date) inv', { inv: '2026-09-10', it: '2026-09-10' }],
  ['SUM(CASE WHEN eta GLOB', { n: 2204, bad: 0 }],
  ['WHERE NOT (', []],
  ["'azamara-mls:prev'", { n: 0 }],
  ['HAVING COUNT(*) > 1', []],
  ['MAX(loading_delivery_date) last_load', [{ ship: 'Summit', last_load: '2027-03-28', rows_: 29 }]],
  ['COUNT(DISTINCT ship) n FROM par', { n: 48 }],
  ["sender = 'cron' AND note LIKE '%send%'", { ts: '2026-09-08 12:00:00' }],
  ['%FAILED%', []],
  ['Azamara MLS REFUSED%', []],
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

// Clean is clean: only the coverage warning, no criticals, nothing repaired.
const clean = await runWatchdog({ HON: fakeDb(base) }, TODAY, { repair: false });
assert.equal(clean.findings.length, 1, 'only the 1-of-48 coverage warning is expected here');
assert.equal(clean.counts.critical, 0);
assert.equal(clean.repairs.length, 0);

console.log('ok - watchdog catches stale feed, format drift, scope leaks and expired schedules,');
console.log('     repairs only its own rows, and recognises the hyphenated MOT variant');
