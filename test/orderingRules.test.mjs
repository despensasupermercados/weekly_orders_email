// node test/orderingRules.test.mjs
//
// THE RULES OTHER APPS READ ARE THE RULES THE EMAIL RUNS. Miguel, 16 Oct 2026:
// Ray's rules "should be cross pollinated to the Brain and across the apps
// that use it". weekly_ordering_rules is how: published nightly from the same
// functions, so HON and the Brain never hold a second copy that can drift.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
import { orderingRules, publishOrderingRules, RULES_TABLE } from '../src/lib/orderingRules.js';
import { tonerSpare, deliveryClass, MONTHLY_PORTS, LONG_HAUL_PORTS, TONER_BUFFER, TONER_BUFFER_LONG_HAUL, PAPER_PALLET } from '../src/lib/runway.js';

function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return st;
    },
  };
}
const get = (rows, rule, key) => rows.find((r) => r.rule === rule && r.key === key)?.value;

{
  const rows = orderingRules();
  // The numbers are the code's, not a second typing of them.
  assert.equal(get(rows, 'toner_spare', 'monthly'), String(TONER_BUFFER));
  assert.equal(get(rows, 'toner_spare', 'long-haul'), String(TONER_BUFFER_LONG_HAUL));
  assert.equal(get(rows, 'toner_spare', 'leaving_usa'), '4', 'the last US order before the ship leaves');
  assert.equal(get(rows, 'toner_spare', 'returning_usa'), '3', 'the first order back in the USA');
  assert.equal(get(rows, 'toner_spare', 'azamara'), String(tonerSpare({ brand: 'Azamara', port: 'BARCELONA' }).spare));
  assert.equal(get(rows, 'toner_spare', 'azamara'), '3', 'Azamara flat +3 (Sep spec)');
  assert.equal(get(rows, 'toner_spare', 'unclassified_port'), '3');
  assert.equal(get(rows, 'usage', 'plan_on'), 'last_month');
  assert.equal(get(rows, 'usage', 'zero_month'), 'trailing_average');
  assert.equal(get(rows, 'paper', 'royal_celebrity'), String(PAPER_PALLET));
  // Every port the code knows, with the class the code gives it.
  const ports = rows.filter((r) => r.rule === 'port_class');
  assert.equal(ports.length, MONTHLY_PORTS.size + LONG_HAUL_PORTS.size, 'no port lost or added');
  for (const r of ports) assert.equal(r.value, deliveryClass(r.key), r.key);
  assert.equal(get(rows, 'port_class', 'VANCOUVER'), 'monthly', 'Ray 7 Sep: international but delivered within the month');
  assert.equal(get(rows, 'port_class', 'CIVITAVECCHIA'), 'long-haul');
  // Every row says where it came from.
  for (const r of rows) assert.ok(r.source && r.value, `${r.rule}/${r.key} has a value and a source`);
  const keys = rows.map((r) => `${r.rule}|${r.key}`);
  assert.equal(new Set(keys).size, keys.length, 'one row per rule and key');
}

{
  const db = new DatabaseSync(':memory:');
  const hon = d1(db);
  const first = await publishOrderingRules(hon, '2026-10-16');
  const n = orderingRules().length;
  assert.deepEqual(first, { written: n, removed: 0 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${RULES_TABLE}`).get().n, n);
  // A rule the code no longer has is removed the next night; the rest stay.
  db.prepare(`INSERT INTO ${RULES_TABLE} VALUES ('toner_spare', 'old_rule', '9', 'gone', '2026-10-16')`).run();
  const second = await publishOrderingRules(hon, '2026-10-17');
  assert.deepEqual(second, { written: n, removed: 1 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${RULES_TABLE} WHERE published_at = '2026-10-17'`).get().n, n);
  // Running twice on one night changes nothing.
  assert.deepEqual(await publishOrderingRules(hon, '2026-10-17'), { written: n, removed: 0 });
  // A failed write keeps last night's table instead of emptying it.
  const failing = { prepare(sql) { const st = hon.prepare(sql); if (/INSERT OR REPLACE/.test(sql)) st.run = async () => { throw new Error('D1 down'); }; return st; } };
  await assert.rejects(publishOrderingRules(failing, '2026-10-18'));
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${RULES_TABLE}`).get().n, n, 'nothing removed when the writes failed');
}

{
  // The nightly cron publishes, and a failure cannot stop the night check.
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const night = src.slice(src.indexOf('if (event.cron === NIGHTLY_CRON) {'), src.indexOf('const report = await runWatchdog('));
  assert.match(night, /try \{\s*await publishOrderingRules\(env\.HON, today\);\s*\} catch/, 'published inside a try, before the night check');
}
console.log('ok - ordering rules: weekly_ordering_rules is written from the code the email runs, every port with its class,');
console.log('     Azamara flat +3, last-month usage; stale rules removed only after a full write');
