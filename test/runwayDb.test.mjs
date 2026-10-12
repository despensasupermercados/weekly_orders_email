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
