// node test/monthEndCounts.test.mjs
//
// THE FIRST MONDAY OF A MONTH, BEFORE LAST MONTH'S COUNTS ARE ON FILE.
// consumption_snapshot is cims-hon's; it writes a month after the month closes
// (September's row appeared with the 1 Oct 2026 export). Until the row for the
// month just ended exists, the six-month window has six counts, not seven, so
// every floor-model item quietly plans on last month - the figure Ray struck on
// 19 Oct - and the computed average is a month short. The run must say so, to
// ops, in its own words; the crew's line must name the rule that did run; and
// a fraction planned on must never print as "you use 0 a month".
// Runs the REAL query in src/lib/runwayDb.js against SQLite.

import assert from 'node:assert';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { DDL } = await import('../src/lib/obpCsv.js');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
const { fleetCoverage } = await import('../src/lib/coverage.js');
const { renderWeekly } = await import('../src/lib/email.js');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand REAL, receipts REAL);
  CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty REAL, sku TEXT, source TEXT);
  CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, loading_port TEXT, loading_delivery_date TEXT, due_date TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);
  CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand REAL, snapshot_date TEXT);
  CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty REAL, snapshot_date TEXT);
`);
for (const sql of DDL) db.exec(sql);
const hon = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    };
    return st;
  },
};

// Monday 2 Nov 2026. Counts on file for April to September only.
const today = '2026-11-02';
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
function item(ship, part, description, counts, receipts, obpOct, { onHand = 1, brand = 'Azamara', par = 5 } = {}) {
  counts.forEach((c, i) => db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run(ship, part, MONTHS[i], c, receipts[i] ?? 0));
  db.prepare('INSERT INTO par (scope, ship, brand, part_number, description, par_qty) VALUES (?,?,?,?,?,?)').run('ship', ship, brand, part, description, par);
  db.prepare("INSERT INTO weekly_obp_inventory (ship, part_number, description, on_hand, snapshot_date, source) VALUES (?,?,?,?,?, 'csv')").run(ship, part, description, onHand, today);
  if (obpOct != null) {
    db.prepare("INSERT INTO weekly_obp_consumption (ship, part_number, description, month, usage, source) VALUES (?,?,?, '2026-10', ?, 'ray-export')").run(ship, part, description, obpOct);
  }
  db.prepare("INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date, source) VALUES (?, 'V1', 'AZAMARA BWS', '2027-03-01', '2026-12-30', 'azamara-mls')").run(ship);
}
db.prepare("INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES ('Elsewhere', 'X', 1, '2027-04-01', ?, 'csv')").run(today);

// A. Quest TN324BK with six months of counts, OBP says 4 used in October.
// With October's counts not on file the six-month window is short a month.
item('A', 'A8DA130', 'TN324BK BLACK TONER', [4, 3, 6, 5, 4, 5], [0, 0, 4, 0, 0, 2], 4);
// B. Paper beside it, unaffected in rule: last month (OBP October) as always.
item('B', '8.5 x 11 / 99PRD75632', '20 LBS 8.5 x 11 DG3 PAPER', [40, 30, 50, 40, 30, 40], [0, 0, 40, 0, 0, 40], 12, { onHand: 5 });

const first = await fleetRunway(hon, today);
assert.equal(first.ran, true, first.reason);
assert.equal(first.month_end.month, '2026-10');
assert.equal(first.month_end.rows, 0);
assert.match(String(first.short), /consumption_snapshot has no month-end counts for 2026-10/, 'the run says it ran short');
const byA = first.findings.find((f) => f.ship === 'A');
const byB = first.findings.find((f) => f.ship === 'B');
assert.ok(byA && byB, 'both items are still judged');
assert.equal(byA.rate, 4, 'floor-model item fell back to OBP\'s last month');
assert.equal(byA.rate_six, null, 'no six-month figure without the seventh count');
assert.equal(byB.rate, 12);

// Ops hear it, in words apart from "did not run"; the fleet email carries it; a crew never sees it.
const checks = [{ name: 'voyage', ran: true }, { name: 'runway', ran: first.ran, reason: first.reason, short: first.short }];
const cov = fleetCoverage({ fleetMap: 'A = a@x.com; B = b@x.com', today, checked: ['A', 'B'], checks });
assert.equal(cov.ok, false, 'a run that ran short is not a clean run');
assert.equal(cov.broken.length, 0, 'but nothing is "did not run"');
assert.equal(cov.short.length, 1);
assert.match(cov.lines[0], /^The runway check ran short — consumption_snapshot has no month-end counts for 2026-10 yet/);
assert.match(cov.lines[0], /Every ship was judged, on a weaker rule than agreed\.$/);
assert.ok(!/\.\./.test(cov.lines[0]), 'no double full stop');
assert.match(cov.note, /1 check\(s\) ran short \(runway\)/);
const opts = { gaps: [], deliveries: [], schedules: [], checked: ['A', 'B'], runsOut: first.findings };
const fleet = renderWeekly([], [], today, { ...opts, coverage: cov }).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
assert.ok(fleet.includes('COULD NOT CHECK'), 'the ops block renders');
assert.ok(fleet.includes('runway check ran short'), 'with the ran-short line');
const crew = renderWeekly([], [], today, { ...opts, coverage: cov, audience: 'ship', ship: 'A' }).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
assert.ok(!/ran short|COULD NOT CHECK|consumption_snapshot/.test(crew), 'a crew never reads a data problem');

// The crew's line names the rule that ran, and that the six-month one did not.
assert.ok(crew.includes('4 last month (OBP) · 1 average of 2 months · we plan on last month · no 6-month figure'), `floor-model item without six months says so: ${crew.slice(crew.indexOf('TN324BK'), crew.indexOf('TN324BK') + 260)}`);
assert.ok(!/PAPER[^]*?no 6-month figure/.test(fleet.slice(fleet.indexOf('B · 20 LBS'), fleet.indexOf('B · 20 LBS') + 400)), 'paper never claims or disclaims the six-month rule');

// Once October's counts arrive the same run is whole again.
for (const [ship, part, c, r] of [['A', 'A8DA130', 4, 0], ['B', '8.5 x 11 / 99PRD75632', 30, 0]]) {
  db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run(ship, part, '2026-10', c, r);
}
const whole = await fleetRunway(hon, today);
assert.equal(whole.short, null, 'with the month on file nothing is short');
assert.equal(whole.month_end.rows, 2);
const wholeA = whole.findings.find((f) => f.ship === 'A');
assert.ok(Math.abs(wholeA.rate_six - 1) < 1e-9, 'A: (4 at end of April + 6 received - 4 at end of October) / 6 = 1');
assert.equal(wholeA.rate, 1, 'the floor-model rule is back on six months');
const cov2 = fleetCoverage({ fleetMap: 'A = a@x.com; B = b@x.com', today, checked: ['A', 'B'], checks: [{ name: 'runway', ran: true, short: whole.short }] });
assert.equal(cov2.ok, true);
assert.equal(cov2.short.length, 0);
// A check that did not run at all is broken, not short, even if it carries both.
const cov3 = fleetCoverage({ fleetMap: 'A = a@x.com', today, checked: ['A'], checks: [{ name: 'runway', ran: false, reason: 'no table', short: 'ignored' }] });
assert.equal(cov3.broken.length, 1);
assert.equal(cov3.short.length, 0);

// THE FIGURE PLANNED ON KEEPS ITS DECIMAL. Journey TN324Y, live on 27 Oct 2026:
// 0 last month, 0.33 over three months, so the email planned on 0.33 and the
// headline rounded it to "you use 0 a month" beside an empty date.
{
  const mk = (o) => ({
    ship: 'Journey', item: 'TN324Y YELLOW TONER', description: 'TN324Y YELLOW TONER',
    on_hand: 1, rate: 0.3, stockout: '2026-12-20', order_due: '2026-11-30', order_lands: '2027-01-05',
    next_loading: '2027-01-05', add_qty: 4, add_basis: 'OBP par is 5', severity: 'warn', ...o,
  });
  const render = (f) => renderWeekly([], [], today, { ...opts, runsOut: [f], audience: 'ship', ship: 'Journey' })
    .replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
  const low = render(mk({ rate_last: 0, rate_avg: 1 / 3, rate_avg_months: 3, rate_source: 'obp' }));
  assert.ok(low.includes('you use 0.3 a month'), `planned on a fraction, printed as one: ${low.slice(low.indexOf('on board'), low.indexOf('on board') + 120)}`);
  assert.ok(low.includes('0 last month (OBP) · 0.3 average of 3 months · we plan on the average · no 6-month figure'), low.slice(low.indexOf('0 last month'), low.indexOf('0 last month') + 120));
  // Last month's own figure is a count and stays whole; the average beside it
  // stays whole too when it is only a reference (Infinity, 23 Sep: "8 average").
  const ref = render(mk({ rate: 11, rate_last: 11, rate_avg: 7.5, rate_avg_months: 2, description: 'RADIANT WHITE 28# 11x17', item: 'RADIANT WHITE 28# 11x17' }));
  assert.ok(ref.includes('you use 11 a month'));
  assert.ok(ref.includes('11 last month · 8 average of 2 months · we plan on last month'), ref.slice(ref.indexOf('11 last month'), ref.indexOf('11 last month') + 100));
  assert.ok(!ref.includes('no 6-month figure'), 'radiant is not a floor-model item');
  // A floor-model item whose two figures agree still names the rule that ran.
  const same = render(mk({ rate: 3, rate_last: 3, rate_avg: 3, rate_avg_months: 3 }));
  assert.ok(same.includes('3 last month · we plan on last month · no 6-month figure'), same.slice(same.indexOf('3 last month'), same.indexOf('3 last month') + 100));
  // A six-month figure under 10 keeps its decimal, as before.
  const six = render(mk({ rate: 1.7, rate_six: 10 / 6, rate_last: 2, rate_source: 'obp' }));
  assert.ok(six.includes('you use 1.7 a month') && six.includes('1.7 a month over 6 months · 2 last month (OBP) · we plan on the 6-month average'));
  assert.ok(!six.includes('no 6-month figure'));
}

console.log('ok - month-end counts: a run without last month\'s counts says it ran short (ops only), the crew line names the rule that ran, and a fraction planned on is never printed as 0');
