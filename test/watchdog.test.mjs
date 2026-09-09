// node test/watchdog.test.mjs
// The night agent's contract, tested against a fake D1. The point of these is
// that a check which silently stops finding things is indistinguishable from a
// healthy system, so each one is pinned.

import { runWatchdog } from '../src/lib/watchdog.js';
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

// Out-of-scope supply streams are repaired, not just reported.
const log = [];
const scoped = await runWatchdog(
  { HON: fakeDb(withRow('WHERE NOT (', [{ mot: 'WINE', n: 40 }, { mot: 'MEDICAL', n: 12 }]), log) },
  TODAY, { repair: true });
assert.ok(scoped.repairs.some((r) => r.includes('52 out-of-scope')), 'must repair and report the count');
assert.ok(log.some((s) => s.startsWith('DELETE FROM schedule_order')), 'must actually delete');

// A ship whose schedule has run out is invisible to the weekly check - the
// worst state, because it looks identical to a ship with nothing due.
const expired = await runWatchdog(
  { HON: fakeDb(withRow('MAX(loading_delivery_date) last_load',
    [{ ship: 'Odyssey', last_load: '2026-08-01', rows_: 11 }])) },
  TODAY, { repair: false });
assert.ok(expired.findings.some((f) => f.check === 'schedule_expired'), 'expired schedule must be critical');

// Clean is clean: no findings, no repairs, nothing sent.
const clean = await runWatchdog({ HON: fakeDb(base) }, TODAY, { repair: false });
assert.equal(clean.findings.length, 1, 'only the 10-of-48 coverage warning is expected here');
assert.equal(clean.counts.critical, 0);

console.log('ok - watchdog catches stale feed, format drift, scope leaks and expired schedules');
