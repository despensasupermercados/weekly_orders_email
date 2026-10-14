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
    ['Utopia', 'TN619C', '2026-08', 10, 0],
    // Vision TN619C: AUGUST is missing. September's previous ROW is July, so a
    // plain LAG would read July's 14 + 0 - 10 = 4 as one month's usage (it is
    // two). The guard drops September; only July (6) is measurable.
    ['Vision', 'TN619C', '2026-06', 20, 0], ['Vision', 'TN619C', '2026-07', 14, 0],
    ['Vision', 'TN619C', '2026-09', 10, 0]]);
  put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [
    ['Freedom', 'TN619Y', 14, T], ['Quest', 'WX103', 0, T], ['Star', 'TN619C', 2, T], ['Utopia', 'TN619C', 2, T], ['Vision', 'TN619C', 2, T]]);
  put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [
    ['ship', 'Freedom', 'Royal', 'TN619Y', 'TN619Y YELLOW TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Quest', 'Azamara', 'WX103', 'WASTE TONER BOX WX-103', 'Toner', null, 2, null, 'SPAR'],
    ['ship', 'Star', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Utopia', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Vision', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR']]);
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

  assert.ok(row('Vision'), 'Vision runs out');
  assert.equal(row('Vision').rate_last, null, 'August missing: September has no previous month to measure from');
  assert.equal(row('Vision').rate_avg_months, 1, 'only July is measurable');
  assert.equal(row('Vision').rate, 6, 'July\'s 6, not the two-month 4 a row-wise LAG would produce');

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
  //   Edge     - the open order lands 20 Nov, BEFORE the gap, and the landing
  //              after it (8 Dec) is after the gap: this order must carry the
  //              toner. A finding that says it arrives in time. (Review of
  //              13 Oct 2026; the day before, this case was asserted silent.)
  //   Summit   - only the 14 Nov landing, dry 30 Nov, nothing else coming,
  //              the open order lands 14 Jan: six dry weeks the crew must hear
  //              about now. The day before this review the test asserted
  //              silence here, calling it "the next order's business"; it is
  //              the open order's business, and the same ship WITHOUT the
  //              14 Nov delivery was always flagged.
  //   Mariner  - Summit's figures with NO ordering schedule: nothing to add to,
  //              so what follows the pipeline is an order not raised yet
  //              (16 Sep 2026). Silent.
  for (const ship of ['Infinity', 'Edge', 'Summit', 'Mariner']) {
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
  const edge = got.find((f) => f.ship === 'Edge');
  assert.ok(edge, 'Edge: the open order lands 20 Nov, before the 30 Nov gap, and can carry the toner: a finding');
  assert.equal(edge.stockout, '2026-11-30');
  assert.equal(edge.order_lands, '2026-11-20');
  assert.equal(edge.next_loading, '2026-12-08', 'the delivery that would otherwise end the gap');
  assert.equal(edge.cycle_days, 18, '20 Nov to the 8 Dec landing');
  assert.equal(edge.add_qty, 13, '16 a month over 18 days is 10, plus 3 spare, nothing on the order yet');
  assert.ok(edge.order_lands < edge.stockout, 'so the email says it arrives before the shelf empties');
  const summit = got.find((f) => f.ship === 'Summit');
  assert.ok(summit, 'Summit: one delivery, dry 30 Nov, the open order lands 14 Jan and nothing else is coming: a finding');
  assert.equal(summit.stockout, '2026-11-30');
  assert.equal(summit.next_loading, null, 'nothing known lands after the shelf empties; the order is the only route');
  assert.equal(summit.order_lands, '2027-01-14');
  assert.equal(got.find((f) => f.ship === 'Mariner'), undefined, 'no open order: dry after the last planned delivery stays silent');
  console.log('ok - runwayDb: an open order that lands before a dry spell, with the next landing after it, is told to carry the item (Edge)');

  // REVIEW OF 13 Oct 2026. The same ship WITHOUT its one small delivery was
  // flagged; WITH it, nothing. Onward (Azamara, toner tolerance zero), real
  // figures: cyan 4 aboard at 3 a month, 1 landing 7 Nov, dry in December,
  // the open order due 3 Dec lands 5 Feb and nothing else is coming. Four
  // Onward rows had this shape on 12 Oct and none was printed. The 11x17 is
  // the other shape: the order lands 5 Feb, the shelf empties 6 Feb, nothing of
  // the item is on that order. Brilliance black is the control that must stay
  // silent: dry 4 Feb, after the landing (30 Nov) that follows the open order
  // (16 Nov) - Ray struck every such row.
  for (const [ship, pn, desc, par, brand, oh, cons] of [
    ['Onward', 'TN328C', 'TN-328C CYAN TONER', 5, 'Azamara', 4, [13, 10, 7, 4]],
    ['Onward', 'P11x17', '20 LBS 11 x 17 DG3 PAPER', null, 'Azamara', 35, [86, 69, 52, 35]],
    ['Brilliance', 'TN634K', 'TN634K BLACK TONER', 10, 'Royal', 15, [30, 25, 20, 15]],
  ]) {
    put('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', ['2026-06', '2026-07', '2026-08', '2026-09'].map((m, i) => [ship, pn, m, cons[i], 0]));
    put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [[ship, pn, oh, T]]);
    put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [['ship', ship, brand, pn, desc, 'Parts', null, par, null, 'SPAR']]);
  }
  put('INSERT INTO obp_intransit VALUES (?,?,?,?,?)', [
    ['Onward', 'TN328C', serial('2026-10-10'), 1, T],   // overdue two days, still counted
    ['Onward', 'TN328C', serial('2026-11-07'), 1, T],
    ['Onward', 'P11x17', serial('2026-11-07'), 11, T], ['Onward', 'P11x17', serial('2026-12-22'), 20, T],
    ['Brilliance', 'TN634K', serial('2027-01-11'), 4, T]]);
  put('INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date) VALUES (?,?,?,?,?)', [
    ['Onward', 'ON1', 'AZAMARA BWS', '2027-02-05', '2026-12-03'],
    ['Brilliance', 'BR1', 'HOTEL BIWEEKLY HOTEL', '2026-11-16', '2026-10-20'],
    ['Brilliance', 'BR2', 'HOTEL BIWEEKLY HOTEL', '2026-11-30', '2026-11-03']]);
  const got2 = (await fleetRunway(d1(gdb), T)).findings;
  const cyan = got2.find((f) => f.ship === 'Onward' && /CYAN/.test(f.item));
  assert.ok(cyan, 'Onward cyan: one delivery, then dry, the open order lands after: a finding');
  assert.equal(cyan.stockout, '2026-12-12');
  assert.equal(cyan.order_lands, '2027-02-05');
  assert.equal(cyan.next_loading, null, 'nothing known lands after the shelf empties');
  assert.equal(cyan.add_qty, 5, 'MFD toner tops up to the OBP par of 5, nothing aboard when the order lands');
  assert.deepEqual(cyan.arrive_first, { qty: 1, by: '2026-11-07', count: 1, late: { qty: 1, since: '2026-10-10' } },
    'the overdue line is counted but named apart with the date OBP gave it');
  const p11 = got2.find((f) => f.ship === 'Onward' && /11 x 17/.test(f.item));
  assert.ok(p11, 'Onward 11x17: the order lands 5 Feb, the shelf empties 6 Feb: a finding');
  assert.equal(p11.stockout, '2027-02-06');
  assert.ok(p11.order_lands < p11.stockout);
  assert.equal(p11.add_qty, 17, 'Azamara paper is strict consumption: 17 a month over the default 30-day cycle');
  assert.equal(got2.find((f) => f.ship === 'Brilliance'), undefined,
    'dry 4 Feb, after the landing that follows the open order: the next order\'s business, silent');
  console.log('ok - runwayDb: a delivery landing first no longer hides a dry spell the open order could fix (Onward, 13 Oct)');
  console.log('ok - runwayDb: a dry spell between two planned deliveries, before the open order lands, is a finding (Infinity, 12 Oct)');
}

// OBP'S OWN USAGE FIGURE WINS (14 Oct 2026). Ray exported September's
// Consumption Statistic. Where a row exists it is last month's usage; the
// computed figure is the fallback; an item OBP reports with no count history
// still gets a rate; OBP's zero falls back to the average like any zero.
{
  const odb = new DatabaseSync(':memory:');
  odb.exec(`
    CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
    CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
    CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
    CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
      loading_port TEXT, loading_delivery_date TEXT, total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
      status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);`);
  const put = (sql, rows) => { const st = odb.prepare(sql); for (const r of rows) st.run(...r); };
  const T = '2026-10-12';
  // Ascent 8.5x11, real: counts give 49 for September, OBP's file says 39.
  put('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)', [
    ['Ascent', 'P85', '2026-06', 60, 0], ['Ascent', 'P85', '2026-07', 50, 40], ['Ascent', 'P85', '2026-08', 44, 0], ['Ascent', 'P85', '2026-09', 35, 40],
    // Star cyan: counts give 3 for September; OBP says 0 -> the average (9, 9) stands in.
    ['Star', 'TN619C', '2026-06', 20, 0], ['Star', 'TN619C', '2026-07', 11, 0], ['Star', 'TN619C', '2026-08', 11, 9], ['Star', 'TN619C', '2026-09', 8, 0]]);
  put('INSERT INTO obp_inventory VALUES (?,?,?,?)', [['Ascent', 'P85', 20, T], ['Star', 'TN619C', 2, T], ['Hero2', 'TN619C', 1, T]]);
  put('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)', [
    ['ship', 'Ascent', 'Celebrity', 'P85', '20 LBS 8.5 x 11 DG3 PAPER', 'Paper', null, 40, null, 'SPAR'],
    ['ship', 'Star', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR'],
    ['ship', 'Hero2', 'Royal', 'TN619C', 'TN619C CYAN TONER', 'Toner', null, 8, null, 'SPAR']]);
  const run = async () => (await fleetRunway(d1(odb), T));
  // Without the table: the computed figure, as before.
  const before = await run();
  assert.equal(before.source.consumption, 'calc');
  const a0 = before.findings.find((f) => f.ship === 'Ascent');
  assert.ok(a0 && a0.rate === 49 && a0.rate_source === 'calc', `computed 49 before the load, got ${JSON.stringify(a0 && [a0.rate, a0.rate_source])}`);
  assert.equal(before.findings.find((f) => f.ship === 'Hero2'), undefined, 'no history, no OBP row: no rate, no claim');
  // Load OBP's September.
  odb.exec(`CREATE TABLE weekly_obp_consumption (ship TEXT NOT NULL, part_number TEXT NOT NULL, description TEXT, month TEXT NOT NULL,
    begin_qty REAL, additions REAL, end_qty REAL, usage REAL NOT NULL, source TEXT, loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ship, part_number, month))`);
  put('INSERT INTO weekly_obp_consumption (ship, part_number, description, month, begin_qty, additions, end_qty, usage, source) VALUES (?,?,?,?,?,?,?,?,?)', [
    ['Ascent', 'P85', '20 LBS 8.5 x 11 DG3 PAPER', '2026-09', 44, 40, 35, 39, 'ray-export'],
    ['Star', 'TN619C', 'TN619C CYAN TONER', '2026-09', 11, 0, 8, 0, 'ray-export'],
    ['Hero2', 'TN619C', 'TN619C CYAN TONER', '2026-09', 4, 0, 1, 3, 'ray-export'],
    ['Ascent', 'P85', '20 LBS 8.5 x 11 DG3 PAPER', '2026-08', 50, 0, 44, 99, 'ray-export']]); // ANOTHER MONTH: never read for October
  const after = await run();
  assert.equal(after.source.consumption, 'obp');
  assert.equal(after.findings.filter((f) => f.ship === 'Ascent').length, 1, 'one row per item: the August OBP row must not join in');
  const a1 = after.findings.find((f) => f.ship === 'Ascent');
  assert.equal(a1.rate, 39, 'OBP\'s 39 over the computed 49, and never August\'s 99');
  assert.equal(a1.rate_last, 39); assert.equal(a1.rate_source, 'obp');
  assert.equal(a1.rate_avg, 35, 'the average stays the computed one: July 50, August 6, September 49');
  assert.equal(a1.rate_avg_months, 3);
  const st = after.findings.find((f) => f.ship === 'Star');
  assert.equal(st.rate_last, 0, 'OBP says zero');
  assert.equal(st.rate, 7, 'a zero month falls back to the computed average (9, 9, 3)');
  const h = after.findings.find((f) => f.ship === 'Hero2');
  assert.ok(h, 'an item with no count history but an OBP figure is measured');
  assert.equal(h.rate, 3); assert.equal(h.rate_source, 'obp'); assert.equal(h.rate_avg, null); assert.equal(h.rate_avg_months, 0);
  console.log('ok - runwayDb: OBP\'s own monthly usage is last month\'s figure where it exists; computed otherwise; the email can say which');
}
