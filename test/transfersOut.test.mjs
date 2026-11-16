// node test/transfersOut.test.mjs
//
// TONER SENT TO ANOTHER SHIP IS NOT TONER USED. Ray, spot check of the 16 Nov
// 2026 email: "Infinity TN619C CYAN TONER ... Incorrect consumption. Ship uses
// between 7-8 toners". We planned on 11 for October: 22 aboard on 1 Oct + 6
// received - 17 aboard on 1 Nov. Eclipse accepted 4 of them on 14 Oct,
// "transfer from infinity". 11 - 4 = 7.
// Runs the REAL queries (src/lib/runwayDb.js, tools/computed-month.mjs)
// against SQLite, on Infinity's real counts.

import assert from 'node:assert';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { DDL } = await import('../src/lib/obpCsv.js');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
const { computedMonthSql } = await import('../tools/computed-month.mjs');

const CYAN = 'A3VX430 / 99PRD67088';
const today = '2026-11-16';
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

function makeDb({ orders = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand REAL, receipts REAL);
    CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty REAL, sku TEXT, source TEXT);
    CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, loading_port TEXT, loading_delivery_date TEXT, due_date TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);
    CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand REAL, snapshot_date TEXT);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty REAL, snapshot_date TEXT);
  `);
  for (const sql of DDL) db.exec(sql);
  if (!orders) db.exec('DROP TABLE weekly_obp_order');
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
  db.prepare("INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES ('Elsewhere', 'X', 1, '2027-04-01', ?, 'csv')").run(today);
  return { db, hon };
}

// An item that runs out before its order lands, so the run reports its rate.
function item(db, ship, part, description, counts, receipts, { onHand = 1, brand = 'Celebrity', par = 5 } = {}) {
  counts.forEach((c, i) => db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run(ship, part, MONTHS[i], c, receipts[i] ?? 0));
  db.prepare('INSERT INTO par (scope, ship, brand, part_number, description, par_qty) VALUES (?,?,?,?,?,?)').run('ship', ship, brand, part, description, par);
  db.prepare("INSERT INTO weekly_obp_inventory (ship, part_number, description, on_hand, snapshot_date, source) VALUES (?,?,?,?,?, 'csv')").run(ship, part, description, onHand, today);
  db.prepare("INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date, source) VALUES (?, 'V1', 'AZAMARA BWS', '2027-03-01', '2026-12-30', 'azamara-mls')").run(ship);
}
const order = (db, ship, part, qty, received, po, inv = po) => db.prepare(
  "INSERT INTO weekly_obp_order (ship, part_number, description, accepted_qty, received_date, po_number, vendor_invoice, snapshot_date, source) VALUES (?,?,?,?,?,?,?,?, 'csv')",
).run(ship, part, 'line', qty, received, po, inv, today);

// Infinity TN619C, end-of-month counts and receipts March to October 2026, as
// on file (consumption_snapshot, 16 Nov 2026). Monthly use by the counts:
// Apr 7, May 10, Jun 8, Jul 8, Aug 8, Sep 8, Oct 11.
const INF_COUNTS = [17, 21, 19, 19, 20, 20, 22, 17];
const INF_RECEIPTS = [0, 11, 8, 8, 9, 8, 10, 6];

{
  const { db, hon } = makeDb();
  item(db, 'Infinity', CYAN, 'TN619C CYAN TONER', INF_COUNTS, INF_RECEIPTS);
  // Eclipse is a ship with its own cyan; it RECEIVED the 4.
  item(db, 'Eclipse', CYAN, 'TN619C CYAN TONER', [10, 10, 10, 10, 10, 10, 10, 10], [0, 5, 5, 5, 5, 5, 5, 9]);
  order(db, 'Eclipse', CYAN, 4, '2026-10-14', 'transfer from infinity');
  // Noise that must not be read as a transfer out of anyone:
  order(db, 'Eclipse', CYAN, 5, '2026-10-06', 'PO152908CCI', '52568725');          // a normal PO
  order(db, 'Infinity', CYAN, 6, '2026-10-05', 'PO146861CCI', '52555154');         // Infinity's own receipt

  const r = await fleetRunway(hon, today);
  assert.equal(r.ran, true, r.reason);
  assert.equal(r.short, null, 'orders on file, month-end on file: nothing short');
  const inf = r.findings.find((f) => f.ship === 'Infinity');
  assert.ok(inf, 'Infinity is judged');
  assert.equal(inf.rate_last, 7, 'October is 22 + 6 - 17 - 4 sent to Eclipse = 7, Ray\'s figure');
  assert.equal(inf.rate, 7, 'and that is what the email plans on');
  assert.ok(Math.abs(inf.rate_avg - (8 + 8 + 7) / 3) < 1e-9, `the average nets it too: Aug 8, Sep 8, Oct 7 (${inf.rate_avg})`);
  const ecl = r.findings.find((f) => f.ship === 'Eclipse');
  assert.ok(ecl, 'Eclipse is judged');
  assert.equal(ecl.rate_last, 9, 'the receiver keeps its own arithmetic: 10 + 9 - 10');
}

// Without the transfer line the same counts plan on 11, as the 16 Nov email
// did: the netting is the only thing that moved.
{
  const { db, hon } = makeDb();
  item(db, 'Infinity', CYAN, 'TN619C CYAN TONER', INF_COUNTS, INF_RECEIPTS);
  const r = await fleetRunway(hon, today);
  assert.equal(r.findings.find((f) => f.ship === 'Infinity').rate_last, 11);
}

// How a line is read: punctuation and case; "from celebrity <ship>"; a line that
// names its own receiver is nobody's; a word that merely starts with a ship's
// name is not that ship; a transfer outside the month is outside the month.
{
  const { db, hon } = makeDb();
  const flat = [10, 10, 10, 10, 10, 10, 10, 10];
  const five = [0, 5, 5, 5, 5, 5, 5, 5];
  item(db, 'Edge', CYAN, 'TN619C CYAN TONER', flat, five);
  item(db, 'Star', CYAN, 'TN619C CYAN TONER', flat, five);
  item(db, 'Adventure', CYAN, 'TN619C CYAN TONER', flat, five);
  item(db, 'Legend', CYAN, 'TN619C CYAN TONER', flat, five);
  item(db, 'Apex', CYAN, 'TN619C CYAN TONER', flat, five);
  order(db, 'Apex', CYAN, 2, '2026-10-09', 'transfer from celebrity edge');          // Edge sent 2
  order(db, 'Apex', CYAN, 1, '2026-10-10', 'ICMANUAL003', 'Transfer from LEGEND.');  // Legend sent 1
  order(db, 'Adventure', CYAN, 1, '2026-10-11', 'VIMANUAL6780', 'Transfer from Adventure'); // names itself
  order(db, 'Apex', CYAN, 3, '2026-10-12', 'from start of cruise');                   // not Star
  order(db, 'Apex', CYAN, 4, '2026-09-20', 'transfer from legend');                    // September, not October
  const r = await fleetRunway(hon, today);
  const last = (ship) => r.findings.find((f) => f.ship === ship).rate_last;
  assert.equal(last('Edge'), 3, '"from celebrity edge" is Edge: 5 - 2');
  assert.equal(last('Legend'), 4, '"Transfer from LEGEND." is Legend: 5 - 1');
  assert.equal(last('Adventure'), 5, 'a line naming its own receiver is not attributed');
  assert.equal(last('Star'), 5, '"from start" is not Star');
  const legend = r.findings.find((f) => f.ship === 'Legend');
  assert.ok(Math.abs(legend.rate_avg - (5 + 1 + 4) / 3) < 1e-9, `Legend's September is 5 - 4 = 1 (${legend.rate_avg})`);
}

// Floor-model toner plans on six months of counts (Ray, 22 Oct). A transfer
// in those six months comes off that figure too.
{
  const { db, hon } = makeDb();
  // 6 aboard at the end of April, 6 received May to October, 6 aboard at the
  // end of October: 6 used in six months by the counts, 1 a month. 3 went to
  // Journey in July: 3 used, 0.5 a month.
  item(db, 'Onward', 'TN328C', 'TN-328C CYAN TONER', [6, 6, 6, 6, 6, 6, 6, 6], [0, 0, 1, 1, 1, 1, 1, 1], { brand: 'Azamara' });
  order(db, 'Journey', 'TN328C', 3, '2026-07-02', 'transfer from onward');
  const r = await fleetRunway(hon, today);
  const f = r.findings.find((x) => x.ship === 'Onward');
  assert.ok(f, 'Onward is judged');
  assert.ok(Math.abs(f.rate_six - 0.5) < 1e-9, `six months: (6 + 6 - 6 - 3) / 6 = 0.5 (${f.rate_six})`);
}

// No order lines on file: nothing is netted, and the run says so to ops.
{
  const { db, hon } = makeDb({ orders: false });
  item(db, 'Infinity', CYAN, 'TN619C CYAN TONER', INF_COUNTS, INF_RECEIPTS);
  const r = await fleetRunway(hon, today);
  assert.equal(r.ran, true, r.reason);
  assert.equal(r.findings.find((f) => f.ship === 'Infinity').rate_last, 11);
  assert.match(String(r.short), /weekly_obp_order is not on file, so toner a ship sent to another ship counts as toner it used/);
}

// tools/computed-month.mjs: our own October when Ray's export has not come.
// It nets the transfer, never replaces a row from Ray's export, and does not
// write a month that goes negative.
{
  const { db } = makeDb();
  db.prepare("INSERT INTO par (scope, ship, part_number, description) VALUES ('ship', 'Infinity', ?, 'TN619C CYAN TONER'), ('ship', 'Eclipse', ?, 'TN619C CYAN TONER'), ('ship', 'Quest', ?, 'TN619C CYAN TONER')").run(CYAN, CYAN, CYAN);
  const open = (ship, part, desc, onHand, date) => db.prepare(
    'INSERT INTO weekly_obp_month_open (ship, part_number, description, on_hand, snapshot_date) VALUES (?,?,?,?,?)').run(ship, part, desc, onHand, date);
  open('Infinity', CYAN, 'TN619C CYAN TONER', 22, '2026-10-01');
  open('Infinity', CYAN, 'TN619C CYAN TONER', 17, '2026-11-01');
  open('Eclipse', CYAN, 'TN619C CYAN TONER', 10, '2026-10-01');
  open('Eclipse', CYAN, 'TN619C CYAN TONER', 12, '2026-11-01');
  open('Quest', CYAN, 'TN619C CYAN TONER', 5, '2026-10-01');
  open('Quest', CYAN, 'TN619C CYAN TONER', 9, '2026-11-01');      // rose with nothing booked: negative
  open('Pursuit', 'FEED', 'PAPER FEED ROLLER', 3, '2026-10-01');   // not a consumable
  open('Pursuit', 'FEED', 'PAPER FEED ROLLER', 1, '2026-11-01');
  order(db, 'Infinity', CYAN, 6, '2026-10-05', 'PO146861CCI');
  order(db, 'Eclipse', CYAN, 4, '2026-10-14', 'transfer from infinity');
  order(db, 'Eclipse', CYAN, 2, '2026-11-02', 'PO1');               // November: not October's
  db.prepare("INSERT INTO weekly_obp_consumption (ship, part_number, description, month, usage, source) VALUES ('Eclipse', ?, 'TN619C CYAN TONER', '2026-10', 3, 'ray-export')").run(CYAN);

  db.exec(computedMonthSql('2026-10', '2026-10-01', '2026-11-01'));
  const rows = db.prepare("SELECT ship, begin_qty, additions, end_qty, usage, source FROM weekly_obp_consumption WHERE month = '2026-10' ORDER BY ship").all();
  const by = Object.fromEntries(rows.map((x) => [x.ship, x]));
  assert.deepEqual({ ...by.Infinity }, { ship: 'Infinity', begin_qty: 22, additions: 6, end_qty: 17, usage: 7, source: 'computed' }, 'Infinity: 22 + 6 - 17 - 4 = 7');
  assert.equal(by.Eclipse.source, 'ray-export', 'Ray\'s row is never replaced');
  assert.equal(by.Eclipse.usage, 3);
  assert.ok(!by.Quest, 'a month that goes negative is not written');
  assert.ok(!by.Pursuit, 'only consumables');
  assert.throws(() => computedMonthSql('2026-10', '2026-11-01', '2026-10-01'), /must be before/);
  assert.throws(() => computedMonthSql('Oct', '2026-10-01', '2026-11-01'), /YYYY-MM/);
}

console.log('ok - transfers out: toner sent to another ship comes off the sender\'s month, its average and its six months (Infinity October 11 -> 7, Ray\'s figure); the receiver keeps its arithmetic; a line naming its own receiver is nobody\'s; the computed month nets it and never replaces Ray\'s export');
