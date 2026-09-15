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
