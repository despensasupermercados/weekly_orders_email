// node test/negativeMonth.test.mjs
//
// TWO THINGS RAY'S 9 NOV 2026 REPLY EXPOSED ("usage is not 11, is 7").
// 1. "(OBP)" WAS PRINTED BESIDE OUR OWN FIGURE. weekly_obp_consumption holds
//    Ray's export (source 'ray-export') and, since 1 Nov, our own fallback
//    for a month he has not sent (source 'computed'). The email tagged both
//    "(OBP)", so Ray read his system's number where there was none.
// 2. A NEGATIVE MONTH WAS DROPPED AND ITS INFLATED NEIGHBOUR KEPT. Infinity
//    TN619Y: 12 aboard end of August, 16 received in September, 12 aboard end
//    of September (16 used), 13 aboard end of October with nothing booked in
//    (-1). The -1 was dropped as a typo, the 16 averaged, and the email
//    planned on 12 a month and added 7 toners to a long-haul order. The two
//    months together are 15 over 2: 7.5 a month, Ray's 7.
// Runs the REAL query in src/lib/runwayDb.js against SQLite.

import assert from 'node:assert';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { DDL } = await import('../src/lib/obpCsv.js');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
const { renderWeekly } = await import('../src/lib/email.js');

const today = '2026-11-09';
function fresh() {
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
  // counts: [[month, on_hand, receipts], ...]; toner on a Celebrity ship, order open.
  const item = (ship, part, description, counts, { onHand = 11, brand = 'Celebrity', par = 8 } = {}) => {
    for (const [m, oh, r] of counts) db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run(ship, part, m, oh, r);
    db.prepare('INSERT INTO par (scope, ship, brand, part_number, description, par_qty) VALUES (?,?,?,?,?,?)').run('ship', ship, brand, part, description, par);
    db.prepare("INSERT INTO weekly_obp_inventory (ship, part_number, description, on_hand, snapshot_date, source) VALUES (?,?,?,?,?, 'csv')").run(ship, part, description, onHand, today);
    db.prepare("INSERT INTO schedule_order (ship, voyage, mot, loading_port, loading_delivery_date, due_date, source) VALUES (?, 'V1', 'HOTEL - MONTHLY', 'Barcelona', '2027-02-07', '2026-11-12', 'test')").run(ship);
  };
  const obpRow = (ship, part, description, month, usage, source) => db.prepare(
    "INSERT INTO weekly_obp_consumption (ship, part_number, description, month, usage, source) VALUES (?,?,?,?,?,?)").run(ship, part, description, month, usage, source);
  db.prepare("INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES ('Elsewhere', 'X', 1, '2027-04-01', ?, 'csv')").run(today);
  return { db, hon, item, obpRow };
}
const text = (findings, ship) => renderWeekly([], [], today, { gaps: [], deliveries: [], schedules: [], checked: [ship], runsOut: findings, audience: 'ship', ship })
  .replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');

// 1. THE LABEL. The same October figure three ways: Ray's export, our fallback, no row.
{
  const { hon, item, obpRow } = fresh();
  // 8, 8, then 11 in October: last month 11, average 9, so the line prints both.
  const counts = [['2026-07', 20, 0], ['2026-08', 20, 8], ['2026-09', 20, 8], ['2026-10', 20, 11]];
  item('A', 'A3VX430', 'TN619C CYAN TONER', counts);
  item('B', 'A3VX430', 'TN619C CYAN TONER', counts);
  item('C', 'A3VX430', 'TN619C CYAN TONER', counts);
  obpRow('A', 'A3VX430', 'TN619C CYAN TONER', '2026-10', 11, 'ray-export');
  obpRow('B', 'A3VX430', 'TN619C CYAN TONER', '2026-10', 11, 'computed');
  const r = await fleetRunway(hon, today);
  const by = Object.fromEntries(r.findings.map((f) => [f.ship, f]));
  assert.ok(by.A && by.B && by.C, `all three judged: ${Object.keys(by)}`);
  assert.equal(by.A.rate, 11); assert.equal(by.B.rate, 11); assert.equal(by.C.rate, 11);
  assert.equal(by.A.rate_source, 'obp', 'Ray\'s export is OBP\'s figure');
  assert.equal(by.B.rate_source, 'calc', 'our fallback row is not OBP\'s figure');
  assert.equal(by.C.rate_source, 'calc', 'no row: the computed figure');
  assert.equal(by.A.rate_last_months, 1);
  assert.ok(text([by.A], 'A').includes('11 last month (OBP) · 9 average of 3 months · we plan on last month'), `A carries the tag: ${text([by.A], 'A').slice(0, 300)}`);
  assert.ok(text([by.B], 'B').includes('11 last month · 9 average of 3 months · we plan on last month'), `B prints the same figures without it: ${text([by.B], 'B').slice(0, 300)}`);
  assert.ok(!text([by.B], 'B').includes('(OBP)'), `B carries no tag: ${text([by.B], 'B').slice(0, 300)}`);
  assert.ok(!text([by.C], 'C').includes('(OBP)'), 'C carries no tag');
  assert.equal(r.source.consumption, 'obp', 'the run reads as OBP-sourced when any export row exists for the month');
}
// The run-level source: a month with only computed rows is 'computed', an empty table 'calc'.
{
  const { hon, item, obpRow } = fresh();
  item('B', 'A3VX430', 'TN619C CYAN TONER', [['2026-09', 20, 0], ['2026-10', 9, 0]]);
  assert.equal((await fleetRunway(hon, today)).source.consumption, 'calc');
  obpRow('B', 'A3VX430', 'TN619C CYAN TONER', '2026-10', 11, 'computed');
  assert.equal((await fleetRunway(hon, today)).source.consumption, 'computed');
}

// 2. THE PAIR. Infinity TN619Y, live on 9 Nov 2026.
{
  const { hon, item } = fresh();
  item('Infinity', 'A3VX230', 'TN619Y YELLOW TONER', [['2026-07', 16, 9], ['2026-08', 12, 4], ['2026-09', 12, 16], ['2026-10', 13, 0]]);
  const r = await fleetRunway(hon, today);
  const f = r.findings.find((x) => x.ship === 'Infinity');
  assert.ok(f, 'judged');
  assert.equal(f.rate_last, 7.5, 'September 16 and October -1 read together: 15 over 2');
  assert.equal(f.rate_last_months, 2);
  assert.equal(f.rate_last_span, 'Sep and Oct');
  assert.equal(f.rate, 7.5, 'and that is the figure planned on, not the 12 average of the inflated month');
  assert.ok(Math.abs(f.rate_avg - (8 + 7.5 + 7.5) / 3) < 1e-9, `the average carries both halves: ${f.rate_avg}`);
  assert.equal(f.rate_avg_months, 3);
  const t = text([f], 'Infinity');
  assert.ok(t.includes('you use 8 a month'), t.slice(0, 200));
  assert.ok(t.includes('8 a month over Sep and Oct, read together: the Oct count went up'), `the line names the pair: ${t.slice(t.indexOf('on board'), t.indexOf('on board') + 220)}`);
  assert.ok(!t.includes('no figure for last month') && !t.includes('(OBP)'), t);
}
// A negative month with nothing positive before it in the window is still dropped.
{
  const { hon, item } = fresh();
  // Jul 10 -> Aug 8: 2; Sep 7: 1; Oct 13 with nothing booked in: -6. 1 - 6 < 0.
  item('D', 'A3VX230', 'TN619Y YELLOW TONER', [['2026-07', 10, 0], ['2026-08', 8, 0], ['2026-09', 7, 0], ['2026-10', 13, 0]], { onHand: 2 });
  const f = (await fleetRunway(hon, today)).findings.find((x) => x.ship === 'D');
  assert.ok(f, 'judged on the average');
  assert.equal(f.rate_last, null, 'September 1 + October -6 is still negative: October is dropped, not shared');
  assert.equal(f.rate_last_months, null);
  assert.equal(f.rate_avg, 1.5, 'the months that stand are August 2 and September 1, untouched');
  assert.equal(f.rate_avg_months, 2);
  assert.equal(f.rate, 1.5);
  assert.ok(text([f], 'D').includes('no figure for last month'));
}
// A negative month in the middle shares with the month before it, and only
// that month: the next one stands on its own.
{
  const { hon, item } = fresh();
  // Jul 20 -> Aug 10 (+4): 14 used; Sep 17 (+0): -7; Oct 17 (+0): 0.
  item('Quest', 'A3VX330', 'TN619M MAGENTA TONER', [['2026-07', 20, 0], ['2026-08', 10, 4], ['2026-09', 17, 0], ['2026-10', 17, 0]], { onHand: 2 });
  const f = (await fleetRunway(hon, today)).findings.find((x) => x.ship === 'Quest');
  assert.ok(f);
  assert.equal(f.rate_last, 0, 'October itself used nothing');
  assert.equal(f.rate_last_months, 1);
  assert.ok(Math.abs(f.rate_avg - (3.5 + 3.5 + 0) / 3) < 1e-9, `August and September share 7 over 2: ${f.rate_avg}`);
  assert.equal(f.rate_avg_months, 3);
  assert.ok(Math.abs(f.rate - (3.5 + 3.5 + 0) / 3) < 0.06, `a zero month plans on that average (one decimal): ${f.rate}`);
}
// Ray's export beats the pair: his October figure is last month, one month.
{
  const { hon, item, obpRow } = fresh();
  item('Infinity', 'A3VX230', 'TN619Y YELLOW TONER', [['2026-07', 16, 9], ['2026-08', 12, 4], ['2026-09', 12, 16], ['2026-10', 13, 0]]);
  obpRow('Infinity', 'A3VX230', 'TN619Y YELLOW TONER', '2026-10', 7, 'ray-export');
  const f = (await fleetRunway(hon, today)).findings.find((x) => x.ship === 'Infinity');
  assert.equal(f.rate_last, 7); assert.equal(f.rate_last_months, 1); assert.equal(f.rate_source, 'obp');
  assert.ok(text([f], 'Infinity').includes('7 last month (OBP)'));
}

console.log('ok - negative month: "(OBP)" only on Ray\'s figure; a negative month is read with the month before it, and the line says so');
