// node test/runwayDb.test.mjs
//
// Runs the REAL SQL from src/lib/runwayDb.js against a real SQLite. The point
// it pins is which order a stockout row is aimed at. On 15 Sep 2026 Quest's
// magenta toner had a container landing 14 Oct - an order that closed on 3 Jul -
// and its next OPEN order was due 8 Dec, on board 18 Dec. Ray Q21: after the
// due date the order "is processed or it's missed", so 14 Oct cannot take a
// line. The email must say: due 8 Dec, arrives 18 Dec, add N.

process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
const assert = (await import('node:assert')).default;

function d1(db) {
  return {
    prepare(sql) {
      const binds = [];
      const stmt = {
        bind(...args) { binds.push(...args); return stmt; },
        async all() { return { results: db.prepare(sql).all(...binds) }; },
        async first() { return db.prepare(sql).get(...binds) ?? null; },
        async run() { return db.prepare(sql).run(...binds); },
      };
      return stmt;
    },
  };
}

// Excel serial for an ISO date, the way obp_intransit stores an ETA.
const serial = (iso) => String(Math.round((Date.parse(iso) - Date.parse('1899-12-30')) / 86400000));

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
  CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
  CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
  CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
  CREATE TABLE schedule_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
    loading_port TEXT, loading_delivery_date TEXT,
    total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
    status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER
  );
`);
const ins = (sql, rows) => { const st = db.prepare(sql); for (const r of rows) st.run(...r); };

// 14 a month for three months, then 3 left aboard.
ins('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', [
  ['Quest', 'TN619M', '2026-05', 20, 0], ['Quest', 'TN619M', '2026-06', 6, 0],
  ['Quest', 'TN619M', '2026-07', 12, 20], ['Quest', 'TN619M', '2026-08', 18, 20],
  // Navigator: same numbers, but NO ordering schedule loaded
  ['Navigator', 'TN619M', '2026-05', 20, 0], ['Navigator', 'TN619M', '2026-06', 6, 0],
  ['Navigator', 'TN619M', '2026-07', 12, 20], ['Navigator', 'TN619M', '2026-08', 18, 20],
]);
ins('INSERT INTO obp_inventory VALUES (?,?,?,?)', [
  ['Quest', 'TN619M', 3, '2026-09-15'], ['Navigator', 'TN619M', 3, '2026-09-15'],
]);
ins('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [
  ['Quest', 'TN619M', serial('2026-10-14'), 4, '2026-09-15'],   // the July order, on its way
  ['Quest', 'TN619M', serial('2026-12-18'), 2, '2026-09-15'],   // two already on the open order
  ['Quest', 'PAPER1', serial('2026-10-14'), 40, '2026-09-15'],
  ['Navigator', 'TN619M', serial('2026-10-24'), 4, '2026-09-15'],
]);
ins('INSERT INTO par (scope, ship, brand, part_number, description, par_qty) VALUES (?,?,?,?,?,?)', [
  ['ship', 'Quest', 'Azamara', 'TN619M', 'TN619M MAGENTA TONER', 4],
  ['ship', 'Quest', 'Azamara', 'PAPER1', '20 LBS 8.5 x 11 DG3 PAPER', null],
  ['ship', 'Navigator', 'RCCL', 'TN619M', 'TN619M MAGENTA TONER', 4],
]);
ins('INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date, source) VALUES (?,?,?,?,?,?)', [
  ['Quest', 'PO-1', 'AZAMARA BWS', '2026-10-14', '2026-07-03', 'azamara-mls'], // closed
  ['Quest', 'PO-2', 'AZAMARA BWS', '2026-12-18', '2026-12-08', 'azamara-mls'], // OPEN
  ['Quest', null,   'AZAMARA BWS', '2027-01-15', '2027-01-05', 'azamara-mls'], // the one after
  ['Quest', 'X',    'DRY DOCK',    '2026-09-20', '2026-09-16', 'ordering-schedule'], // not eligible
]);

const today = '2026-09-15';
const r = await fleetRunway(d1(db), today);
assert.equal(r.ran, true, r.reason);
const quest = r.findings.find((f) => f.ship === 'Quest' && /MAGENTA/.test(f.item));
assert.ok(quest, 'Quest magenta is a RUNS_OUT finding');
assert.equal(quest.next_loading, '2026-10-14');    // the container on its way (fact)
assert.equal(quest.order_due, '2026-12-08');       // the order that can still take a line
assert.equal(quest.order_lands, '2026-12-18');
assert.equal(quest.cover_to, '2027-01-15');        // one full cycle: 18 Dec -> 15 Jan
assert.equal(quest.cycle_days, 28);
assert.equal(quest.on_order, 2);                   // already on the 18 Dec order
assert.equal(quest.has_schedule, true);
// 14 a month * 28/30 = 13.07 -> 14, + 3 spare, less the 2 already on it.
assert.equal(quest.add_qty, 14 + 3 - 2);
// The 20 Sep dry-dock row is not an order the printer can use.
assert.notEqual(quest.order_due, '2026-09-16');

const nav = r.findings.find((f) => f.ship === 'Navigator');
assert.ok(nav, 'Navigator is a RUNS_OUT finding');
assert.equal(nav.next_loading, '2026-10-24');
assert.equal(nav.order_due, null);
assert.equal(nav.order_lands, null);
assert.equal(nav.has_schedule, false);
assert.equal(nav.cycle_days, 30);
assert.equal(nav.add_qty, 17);

console.log('ok - runwayDb: the quantity is aimed at the order still open (due date ahead),');
console.log('     never at a container whose order already closed; no schedule -> no due date');


// A NEWER SNAPSHOT WITH NO READING. Navigator's row says nothing about the
// shelf (NULL) and Quest has no row at all in that snapshot: neither is an
// empty shelf. Both are reported as unread and neither is a finding.
{
  ins('INSERT INTO obp_inventory VALUES (?,?,?,?)', [['Navigator', 'TN619M', null, '2026-09-16']]);
  const r2 = await fleetRunway(d1(db), today);
  assert.ok(r2.ran, r2.reason);
  const names = r2.unread.map((u) => u.ship).sort();
  assert.deepEqual(names, ['Navigator', 'Quest'], `unread items are named: ${JSON.stringify(r2.unread)}`);
  assert.equal(r2.findings.filter((f) => /TN619M/.test(f.item)).length, 0, 'and none of them is called a stockout');
  console.log('ok - runwayDb: NULL on-hand carries through as unread, never as 0');
}

// REVIEW OF 12 Oct 2026 (Ray's review of the 12 Oct email): A LATE DELIVERY IS
// STILL A DELIVERY. Oasis had 40 cases of 11x17 due 11 Oct, still in the
// in-transit export on the 12th - late, or aboard and not yet booked. The query
// kept only ETAs from today on, the 40 cases vanished, and the email told Oasis
// to add 40 more. Ray: "no paper order required". Five other ships had the same
// shape the same Monday (Eclipse, Equinox x2, Quantum, Summit).
{
  const ldb = new DatabaseSync(':memory:');
  ldb.exec(`
    CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
    CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
    CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
    CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
      loading_port TEXT, loading_delivery_date TEXT, total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
      status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);`);
  const put = (sql, rows) => { const st = ldb.prepare(sql); for (const r of rows) st.run(...r); };
  const T = '2026-10-12';
  // Oasis's real 11x17 history: 21, 19, 25 a month (last month 25).
  put('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', [
    ['Oasis', 'P11x17', '2026-06', 67, 40], ['Oasis', 'P11x17', '2026-07', 46, 0],
    ['Oasis', 'P11x17', '2026-08', 27, 0], ['Oasis', 'P11x17', '2026-09', 42, 40]]);
  put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [['Oasis', 'P11x17', 34, T]]);
  put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [['ship', 'Oasis', 'Royal', 'P11x17', '20 LBS 11 x 17 DG3 PAPER', 'Paper', null, 40, null, 'SPAR']]);
  put('INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date) VALUES (?,?,?,?,?)', [
    ['Oasis', 'OA1', 'HOTEL BIWEEKLY HOTEL', '2026-11-06', '2026-10-15'],
    ['Oasis', 'OA2', 'HOTEL BIWEEKLY HOTEL', '2026-11-20', '2026-10-29']]);
  put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [['Oasis', 'P11x17', serial('2026-12-04'), 40, T]]);
  const oasis = async () => (await fleetRunway(d1(ldb), T)).findings.filter((f) => f.ship === 'Oasis');

  // Control: with no late line the ship really is short, and is told so.
  const without = await oasis();
  assert.equal(without.length, 1, 'with no late delivery, 34 cases at 25 a month do run out before 4 Dec');
  assert.equal(without[0].add_qty, 40);

  // The real Monday: 40 cases due 11 Oct, still in transit.
  put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [['Oasis', 'P11x17', serial('2026-10-11'), 40, T]]);
  const withLate = await oasis();
  assert.equal(withLate.length, 0, `a delivery one day late is still coming; nothing to add: ${JSON.stringify(withLate.map((f) => [f.stockout, f.add_qty]))}`);
  console.log('ok - runwayDb: a late delivery still in transit counts as arriving today (Oasis, Ray 12 Oct)');
}

// RAY, 12 Oct 2026: "the usage used was from last month". The rate was the
// higher of last month and the average; Ray struck two rows of the 12 Oct
// email that only the higher figure produced. Freedom's yellow toner, its real
// history: used 6, 5, 3 (last month 3, average 4.7). At 4.7 a month its 14
// run out on 11 Jan, three days before the 14 Jan delivery, and the email
// asked for 6. At last month's 3 they last into February. Ray: 0, "current
// consumption and orders in line".
{
  const rdb = new DatabaseSync(':memory:');
  rdb.exec(`
    CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
    CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
    CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
    CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
      loading_port TEXT, loading_delivery_date TEXT, total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
      status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);`);
  const put = (sql, rows) => { const st = rdb.prepare(sql); for (const r of rows) st.run(...r); };
  const T = '2026-10-12';
  put('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', [
    // Freedom TN619Y, real: 9, 8 (+5), 10 (+7), 13 (+6) -> used 6, 5, 3.
    ['Freedom', 'TN619Y', '2026-06', 9, 3], ['Freedom', 'TN619Y', '2026-07', 8, 5],
    ['Freedom', 'TN619Y', '2026-08', 10, 7], ['Freedom', 'TN619Y', '2026-09', 13, 6],
    // Quest WX-103, real: 3, 1, 1 (+2), 1 -> used 2, 2, 0. Zero aboard today.
    ['Quest', 'WX103', '2026-06', 3, 0], ['Quest', 'WX103', '2026-07', 1, 0],
    ['Quest', 'WX103', '2026-08', 1, 2], ['Quest', 'WX103', '2026-09', 1, 0],
    // Star TN619C: used 9, 9, 3 -> plans on 3, not 7.
    ['Star', 'TN619C', '2026-06', 20, 0], ['Star', 'TN619C', '2026-07', 11, 0],
    ['Star', 'TN619C', '2026-08', 11, 9], ['Star', 'TN619C', '2026-09', 8, 0],
    // Utopia TN619C: no September reading, so no last month -> the average.
    ['Utopia', 'TN619C', '2026-06', 20, 0], ['Utopia', 'TN619C', '2026-07', 14, 0],
    ['Utopia', 'TN619C', '2026-08', 10, 0]]);
  put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [
    ['Freedom', 'TN619Y', 14, T], ['Quest', 'WX103', 0, T], ['Star', 'TN619C', 2, T], ['Utopia', 'TN619C', 2, T]]);
  put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [
    ['ship', 'Freedom', 'Royal', 'TN619Y', 'TN619Y YELLOW TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Quest', 'Azamara', 'WX103', 'WASTE TONER BOX WX-103', 'Toner', null, 2, null, 'SPAR'],
    ['ship', 'Star', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Utopia', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR']]);
  put('INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date) VALUES (?,?,?,?,?)', [
    ['Freedom', 'FR1', 'HOTEL BIWEEKLY HOTEL', '2026-11-05', '2026-10-14']]);
  put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [
    ['Freedom', 'TN619Y', serial('2027-01-14'), 2, T], ['Freedom', 'TN619Y', serial('2027-02-06'), 3, T]]);
  const got = (await fleetRunway(d1(rdb), T)).findings;
  const row = (ship) => got.find((f) => f.ship === ship);

  assert.equal(row('Freedom'), undefined,
    `Freedom plans on last month's 3, its 14 reach the 14 Jan delivery; nothing to ask: ${JSON.stringify(row('Freedom'))}`);

  assert.ok(row('Star'), 'Star, 2 aboard, runs out either way');
  assert.equal(row('Star').rate, 3, 'Star plans on last month (3), not the average (7) and not the higher one');
  assert.equal(row('Star').rate_last, 3);

  assert.ok(row('Utopia'), 'Utopia runs out');
  assert.equal(row('Utopia').rate_last, null, 'no September reading: last month has no figure');
  assert.equal(row('Utopia').rate, 5, 'so the average of July and August (6, 4) stands in');

  // A zero month on an item the ship used before. Ray's rule for it is not
  // known; planning on zero would drop an empty shelf from the email.
  assert.ok(row('Quest'), 'Quest WX-103, none aboard, used 2 and 2 before a zero month: still in the email');
  assert.equal(row('Quest').rate_last, 0);
  assert.equal(row('Quest').rate, 1.3, 'the zero month falls back to the average of 2, 2, 0 (1.3 as carried)');
  console.log('ok - runwayDb: usage is last month (Ray 12 Oct); the average only when last month has no figure or reads zero');
}

// A DRY SPELL BETWEEN TWO PLANNED DELIVERIES (12 Oct 2026). The stock walk saw
// only the first landing; if it arrived before the shelf emptied the item was
// "covered", whatever came after. Infinity's yellow toner, real figures: 18
// aboard, 16 used last month, 8 landing each month. The 8 on 14 Nov carry it to
// 30 Nov; the next 8 land 8 Dec; the open order lands 14 Jan. Eight dry days
// nothing the crew adds can prevent - and the email said nothing.
{
  const gdb = new DatabaseSync(':memory:');
  gdb.exec(`
    CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
    CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
    CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
    CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
      loading_port TEXT, loading_delivery_date TEXT, total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
      status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);`);
  const put = (sql, rows) => { const st = gdb.prepare(sql); for (const r of rows) st.run(...r); };
  const T = '2026-10-12';
  // Three hulls with Infinity's figures; only the landings differ.
  //   Infinity - the real case: open order lands 14 Jan, after the gap.
  //   Edge     - the open order lands 20 Nov, BEFORE the gap: the open order
  //              can still close it; Ray (13 Oct) wants no row; no finding.
  //   Summit   - only the 14 Nov landing: dry after the LAST planned delivery
  //              is the next order's business, as before; no finding.
  for (const ship of ['Infinity', 'Edge', 'Summit']) {
    put('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', [
      [ship, 'TN619Y', '2026-06', 15, 9], [ship, 'TN619Y', '2026-07', 16, 9],
      [ship, 'TN619Y', '2026-08', 12, 4], [ship, 'TN619Y', '2026-09', 12, 16]]);
    put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [[ship, 'TN619Y', 18, T]]);
    put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [['ship', ship, 'Celebrity', 'TN619Y', 'TN619Y YELLOW TONER', 'Parts', 'C4070', 10, null, 'SPAR']]);
    put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [[ship, 'TN619Y', serial('2026-11-14'), 8, T]]);
  }
  for (const ship of ['Infinity', 'Edge']) {
    put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [
      [ship, 'TN619Y', serial('2026-12-08'), 8, T], [ship, 'TN619Y', serial('2027-01-02'), 8, T], [ship, 'TN619Y', serial('2027-02-07'), 8, T]]);
  }
  put('INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date) VALUES (?,?,?,?,?)', [
    ['Infinity', null, 'HOTEL BIWEEKLY HOTEL', '2027-01-14', '2026-10-22'],
    ['Infinity', null, 'HOTEL BIWEEKLY HOTEL', '2027-01-26', '2026-10-29'],
    ['Edge', null, 'HOTEL BIWEEKLY HOTEL', '2026-11-20', '2026-10-22'],
    ['Summit', null, 'HOTEL BIWEEKLY HOTEL', '2027-01-14', '2026-10-22']]);
  const got = (await fleetRunway(d1(gdb), T)).findings;
  const inf = got.find((f) => f.ship === 'Infinity');
  assert.ok(inf, 'Infinity runs dry between the 14 Nov and 8 Dec deliveries: a finding');
  assert.equal(inf.stockout, '2026-11-30', '18 + 8 at 16 a month');
  assert.equal(inf.next_loading, '2026-12-08', 'the delivery that ends the gap, not the one before it');
  assert.equal(inf.order_due, '2026-10-22');
  assert.equal(inf.order_lands, '2027-01-14');
  assert.deepEqual(inf.arrive_first, { qty: 8, by: '2026-11-14', count: 1 }, 'the 8 counted in the empty date are named');
  assert.equal(got.find((f) => f.ship === 'Edge'), undefined, 'the open order lands before the gap: not built, no finding');
  assert.equal(got.find((f) => f.ship === 'Summit'), undefined, 'dry only after the last planned delivery: no finding');
  console.log('ok - runwayDb: a dry spell between two planned deliveries, before the open order lands, is a finding (Infinity, 12 Oct)');
}
