// node test/obpCsv.test.mjs
//
// The OBP CSV route. The workbook mirror cims-hon ingests stalled for six days
// in September 2026 while the CSV exports it is built from moved every night
// (Allure magenta: mirror 10, export 17). These pin three things: the export's
// own column names and date format are read correctly, the Worker's copy is
// written to its OWN tables and never to obp_*, and every reader takes the
// fresher of the two copies.

process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const assert = (await import('node:assert')).default;
const { parseCsv, usDate, mapInventory, mapIntransit, isObpCsvMail, ingestObpCsv, MIN_INVENTORY_ROWS, CSV_FILES, num, missingHeaders, MAX_BLANK_SHARE } =
  await import('../src/lib/obpCsv.js');
const { obpSource, CSV_INVENTORY, CSV_INTRANSIT } = await import('../src/lib/obpSource.js');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
const { unscheduledGaps } = await import('../src/lib/fallback.js');
const { voyageStates } = await import('../src/lib/due.js');

// D1 over node:sqlite, including batch(), which the ingest uses when present.
// D1's bind() returns a NEW statement, so one prepared INSERT can be bound
// once per record and the results batched; the stand-in must do the same or
// every row in the batch carries the last record's values.
function d1(db) {
  const make = (sql, binds) => ({
    bind(...args) { return make(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { return db.prepare(sql).run(...binds); },
  });
  return {
    prepare(sql) { return make(sql, []); },
    async batch(stmts) { for (const s of stmts) await s.run(); return []; },
  };
}

// ---- the parser, on the export's own shape ----
const INV_HEAD = 'ShipName,UpdateDate,PartID,PartCategory,PartNumber,PartDescr,PartsSortOrder,Quantity,PartPrice,Total Price,InventoryID,CustomerName,Supplier';
const invLine = (ship, part, descr, qty, upd = '09/15/26  7:07:32 PM') =>
  `${ship},${upd},39,Parts,${part},"${descr}",38,${qty},4.8100,19.2400,371,Royal Caribbean,Konica`;
const TR_HEAD = 'ShipName,OrdersID,PONumber,VendorInvoiceNumber,OrderDate,PlacedBy,VoyageNum,ShipProvPort,ShipProvDate,PartID,PartCategory,PartNumber,PartDescr,Quantity,PartPrice,Total Price,CustomerName,Supplier';
const trLine = (ship, part, descr, qty, prov) =>
  `${ship},6085,PO311570RCL,52603289,08/24/26  7:36:11 AM,Karl Lanuza,RAD260918008,PORT CANAVERAL,${prov},2,Parts,${part},${descr},${qty},76.6600,383.3000,Royal Caribbean,`;

const rows = parseCsv('﻿' + INV_HEAD + '\r\n' + invLine('Adventure', '8.5 x 11 / 99PRD75632', '8.5 X 11 PAPER, 24LB', 35) + '\r\n');
assert.equal(rows.length, 1);
assert.equal(rows[0].ShipName, 'Adventure', 'the BOM must not end up inside the first header');
assert.equal(rows[0].PartDescr, '8.5 X 11 PAPER, 24LB', 'a quoted field with a comma stays one field');
assert.equal(usDate('9/18/2026 12:00:00 AM'), '2026-09-18');
assert.equal(usDate('01/29/24  7:07:32 PM'), '2024-01-29');
assert.equal(usDate('2026-09-18'), '2026-09-18');
assert.equal(usDate('not a date'), null, 'a date we cannot read is null, never a guess');
assert.ok(isObpCsvMail('onboardinventory.csv intransititems.csv', 'OBP nightly'));
assert.ok(!isObpCsvMail('Azamara MLS 2025.xlsx', 'Azamara MLS'));

const inv = mapInventory(rows, '2026-09-16');
assert.deepEqual(inv[0], {
  ship: 'Adventure', part_number: '8.5 x 11 / 99PRD75632', description: '8.5 X 11 PAPER, 24LB',
  category: 'Parts', on_hand: 35, update_date: '2026-09-15', snapshot_date: '2026-09-16',
});
const tr = mapIntransit(parseCsv(TR_HEAD + '\n' + trLine('Adventure', 'A3VX230 / 99PRD67086', 'TN619Y YELLOW TONER', 5, '9/18/2026 12:00:00 AM')), '2026-09-16');
assert.equal(tr[0].eta_date, '2026-09-18', 'ShipProvDate is the landing date');
assert.equal(tr[0].qty, 5);
assert.equal(tr[0].voyage, 'RAD260918008');
console.log('ok - obp csv: the export\'s own headers, quoted fields, US dates and the BOM are read');

// ---- the ingest writes its own tables and nothing else ----
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand INTEGER, snapshot_date TEXT);
  CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty INTEGER, snapshot_date TEXT);
  CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand INTEGER, receipts INTEGER);
  CREATE TABLE par (scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty INTEGER, sku TEXT, source TEXT);
  CREATE TABLE schedule_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
    loading_port TEXT, loading_delivery_date TEXT, total_lead_days INTEGER, due_date TEXT,
    must_be_in_ct_by TEXT, status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);
`);
const hon = d1(db);
const serial = (iso) => String(Math.round((Date.parse(iso) - Date.parse('1899-12-30')) / 86400000));

// The mirror: Allure magenta 10 aboard, a container on 14 Oct, snapshot 15 Sep.
db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', 10, '2026-09-15');
db.prepare('INSERT INTO obp_intransit VALUES (?,?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', serial('2026-10-14'), 6, '2026-09-15');
for (const [m, oh, rc] of [['2026-05', 20, 0], ['2026-06', 6, 0], ['2026-07', 12, 20], ['2026-08', 18, 20]])
  db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', m, oh, rc);
db.prepare('INSERT INTO par VALUES (?,?,?,?,?,?,?,?,?,?)').run('ship', 'Allure', 'Royal', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 'Toner', 'C6100', 12, null, 'SPAR');
db.prepare(`INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date) VALUES (?,?,?,?,?)`)
  .run('Allure', 'AL0001', 'HOTEL BIWEEKLY HOTEL', '2026-10-14', '2026-09-30');

// No CSV yet: every reader is on the mirror.
let src = await obpSource(hon);
assert.equal(src.inventory.source, 'mirror');
assert.equal(src.intransit.source, 'mirror');
let states = await voyageStates(hon, '2026-09-16');
assert.equal(states[0].state, 'ORDERED', 'the mirror shows the 14 Oct container, so the voyage is ordered');

// A fleet-wide export, fresher than the mirror: Allure now has 17 aboard, and
// the 14 Oct line is gone (it landed early) - a new container is due 20 Oct.
const invCsv = [INV_HEAD];
for (let i = 0; i < MIN_INVENTORY_ROWS; i++) invCsv.push(invLine(`Ship${i % 48}`, `P${i}`, 'FILLER', 1));
// The export says 3 aboard (the mirror still says 10): it runs dry before the
// 20 Oct container, which is the finding the crew has to hear about.
invCsv.push(invLine('Allure', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 3));
const trCsv = [TR_HEAD,
  trLine('Allure', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 6, '10/20/2026 12:00:00 AM'),
  // Beyond has no ordering schedule: the gap check draws its deliveries from here.
  trLine('Beyond', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 6, '10/05/2026 12:00:00 AM'),
  trLine('Beyond', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 6, '11/02/2026 12:00:00 AM'),
];
const attachments = [
  { filename: CSV_FILES.inventory, content: invCsv.join('\r\n') },
  { filename: 'IntransitItems.csv', content: trCsv.join('\r\n') }, // case must not matter
  { filename: CSV_FILES.orders, content: 'ShipName\nAdventure' },
];
const r = await ingestObpCsv(hon, attachments, '2026-09-16');
assert.equal(r.refused.length, 0, `nothing refused: ${r.refused.join('; ')}`);
assert.equal(r.inventory, MIN_INVENTORY_ROWS + 1);
assert.equal(r.intransit, 3);
assert.equal(r.inventory_newest_update, '2026-09-15');

// THE MIRROR IS UNTOUCHED. obp_* belongs to cims-hon.
assert.equal(db.prepare('SELECT on_hand FROM obp_inventory').get().on_hand, 10, 'obp_inventory is never written');
assert.equal(db.prepare('SELECT COUNT(*) n FROM obp_intransit').get().n, 1, 'obp_intransit is never written');
assert.equal(db.prepare(`SELECT on_hand FROM ${CSV_INVENTORY} WHERE ship='Allure'`).get().on_hand, 3);
assert.equal(db.prepare(`SELECT eta_date FROM ${CSV_INTRANSIT} WHERE ship='Allure'`).get().eta_date, '2026-10-20');

// Every reader now takes the CSV copy.
src = await obpSource(hon);
assert.equal(src.inventory.source, 'csv');
assert.equal(src.intransit.source, 'csv');
const run = await fleetRunway(hon, '2026-09-16');
assert.equal(run.source.inventory, 'csv');
const allure = run.findings.find((f) => f.ship === 'Allure');
assert.ok(allure, `Allure is judged from the CSV copy: ${JSON.stringify(run.findings.map((f) => f.ship))}`);
assert.equal(allure.on_hand, 3, 'on hand comes from the export, not the stale mirror');
assert.equal(allure.next_loading, '2026-10-20', 'the next landing is the CSV\'s ISO date, read without a serial conversion');
states = await voyageStates(hon, '2026-09-16');
assert.notEqual(states[0].state, 'ORDERED', 'with the CSV copy the 14 Oct voyage has no line landing that day');
const gaps = await unscheduledGaps(hon, '2026-09-16');
assert.ok(gaps.ran, `the schedule-free check runs on the CSV copy: ${gaps.reason}`);
assert.deepEqual(gaps.deliveries.map((d) => d.date), ['2026-10-05', '2026-11-02'], 'Beyond\'s landings come from the CSV copy as ISO dates');
assert.ok(!gaps.deliveries.some((d) => d.ship === 'Allure'), 'a ship with a schedule is not in the schedule-free list');
console.log('ok - obp csv: written to weekly_obp_* only, and runway, due and gap checks all read the fresher copy');

// A truncated download is refused and yesterday's copy stays.
const small = await ingestObpCsv(hon, [{ filename: CSV_FILES.inventory, content: invCsv.slice(0, 20).join('\n') }], '2026-09-17');
assert.equal(small.inventory, 0);
assert.ok(/below/.test(small.refused[0]), `a small file is refused: ${small.refused[0]}`);
assert.equal(db.prepare(`SELECT MAX(snapshot_date) d FROM ${CSV_INVENTORY}`).get().d, '2026-09-16', 'the previous snapshot is kept');

// A mirror that overtakes the CSV wins again: if the flow stops attaching
// files, the readers fall back on their own.
db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', 11, '2026-09-20');
db.prepare('INSERT INTO obp_intransit VALUES (?,?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', serial('2026-10-14'), 6, '2026-09-20');
src = await obpSource(hon);
assert.equal(src.inventory.source, 'mirror', 'a newer mirror snapshot takes over');
console.log('ok - obp csv: a truncated file is refused, and a newer mirror snapshot takes precedence again');

// A SHIP THE EXPORT DID NOT COVER KEEPS ITS MIRROR FIGURES. The 16 Sep 2026
// load was half a file: the connector cuts at 200,000 characters. A snapshot
// carrying half the fleet must not make the other half read as empty.
{
  db.exec('DELETE FROM obp_inventory; DELETE FROM obp_intransit;');
  db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', 10, '2026-09-21');
  db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Voyager', 'A3VX330 / 99PRD67087', 8, '2026-09-21');
  db.prepare('INSERT INTO obp_intransit VALUES (?,?,?,?,?)').run('Voyager', 'A3VX330 / 99PRD67087', serial('2026-10-16'), 6, '2026-09-21');
  const half = [INV_HEAD];
  for (let i = 0; i < MIN_INVENTORY_ROWS; i++) half.push(invLine('Adventure', `P${i}`, 'FILLER', 1));
  half.push(invLine('Allure', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 17));
  const r2 = await ingestObpCsv(hon, [
    { filename: CSV_FILES.inventory, content: half.join('\n') },
    { filename: CSV_FILES.intransit, content: [TR_HEAD, trLine('Allure', 'A3VX330 / 99PRD67087', 'TN619M MAGENTA TONER', 6, '10/20/2026 12:00:00 AM')].join('\n') },
  ], '2026-09-21');
  assert.equal(r2.refused.length, 0, r2.refused.join('; '));
  assert.equal(r2.filled.inventory, 1, 'Voyager, absent from the export, is filled from the mirror');
  assert.equal(r2.filled.intransit, 1);
  const v = db.prepare(`SELECT on_hand, source FROM ${CSV_INVENTORY} WHERE ship='Voyager' AND snapshot_date='2026-09-21'`).get();
  assert.deepEqual(v, { on_hand: 8, source: 'mirror-fill' });
  const a = db.prepare(`SELECT on_hand, source FROM ${CSV_INVENTORY} WHERE ship='Allure' AND snapshot_date='2026-09-21'`).get();
  assert.deepEqual(a, { on_hand: 17, source: 'csv' }, 'a ship the export covers is not overwritten by the fill');
  const vt = db.prepare(`SELECT eta_date, qty, source FROM ${CSV_INTRANSIT} WHERE ship='Voyager' AND snapshot_date='2026-09-21'`).get();
  assert.deepEqual(vt, { eta_date: '2026-10-16', qty: 6, source: 'mirror-fill' }, 'the mirror\'s Excel serial becomes an ISO date in the fill');
  console.log('ok - obp csv: a half-fleet export is completed from the mirror, ship by ship, never overwriting fresh rows');
}

// A MIRROR THAT HAS NOT MOVED IS NOT FRESHER. The workbook mirror is stamped
// every morning whether or not a value changed. A CSV copy loaded yesterday
// must beat a mirror snapshot from today whose content equals yesterday's;
// a mirror that really changed wins on date again.
{
  db.exec('DELETE FROM obp_inventory; DELETE FROM obp_intransit;');
  db.exec(`DELETE FROM ${CSV_INVENTORY}; DELETE FROM ${CSV_INTRANSIT};`);
  db.prepare(`INSERT INTO ${CSV_INVENTORY} (ship, part_number, on_hand, snapshot_date, source) VALUES (?,?,?,?,?)`).run('Allure', 'A3VX330 / 99PRD67087', 17, '2026-09-16', 'csv');
  db.prepare(`INSERT INTO ${CSV_INTRANSIT} (ship, part_number, qty, eta_date, snapshot_date, source) VALUES (?,?,?,?,?,?)`).run('Allure', 'A3VX330 / 99PRD67087', 6, '2026-10-20', '2026-09-16', 'csv');
  // The mirror: identical content on 16 and 17 Sep - re-stamped, not refreshed.
  for (const d of ['2026-09-16', '2026-09-17']) {
    db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', 10, d);
    db.prepare('INSERT INTO obp_intransit VALUES (?,?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', serial('2026-10-14'), 6, d);
  }
  let s = await obpSource(hon);
  assert.equal(s.inventory.source, 'csv', 'a re-stamped mirror does not outrank yesterday\'s CSV copy');
  assert.equal(s.intransit.source, 'csv');
  assert.equal(s.mirror.frozen.inventory, true);
  // 18 Sep: the workbook really refreshed - the content moved - so the mirror wins.
  db.prepare('INSERT INTO obp_inventory VALUES (?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', 14, '2026-09-18');
  db.prepare('INSERT INTO obp_intransit VALUES (?,?,?,?,?)').run('Allure', 'A3VX330 / 99PRD67087', serial('2026-10-14'), 9, '2026-09-18');
  s = await obpSource(hon);
  assert.equal(s.inventory.source, 'mirror', 'a mirror whose content changed is fresher and wins');
  assert.equal(s.intransit.source, 'mirror');
  console.log('ok - obp source: a re-stamped, unchanged mirror never outranks a CSV copy; a real refresh does');
}


// A ZERO IS A CLAIM, A NULL IS AN ABSENCE. cims-hon, 17 Sep 2026, by executing
// both readers over the same file: num(undefined) was 0, so a renamed Quantity
// column would have written ~3,500 zeros and mailed 48 crews a fleet-wide
// stockout. The contract below mirrors cims-hon/test/obp_contract.test.js.
{
  assert.equal(num(undefined), null); assert.equal(num(null), null); assert.equal(num(''), null); assert.equal(num('  '), null);
  assert.equal(num('0'), 0, 'a genuine zero is a zero'); assert.equal(num(0), 0);
  assert.equal(num('7'), 7); assert.equal(num('1,240'), 1240, 'thousands comma'); assert.equal(num('N/A'), null);
  const [m] = mapInventory([{ ShipName: 'Beyond', PartNumber: 'P1', Quantity: '' , UpdateDate: '09/15/26' }], '2026-09-17');
  assert.equal(m.on_hand, null, 'an absent Quantity is null in the row, not 0');
  assert.deepEqual(missingHeaders([{ ShipName: 'x', PartNumber: 'y', UpdateDate: 'z', OnHand: '1' }], 'inventory'), ['Quantity']);
  assert.deepEqual(missingHeaders([], 'inventory'), ['ShipName', 'PartNumber', 'Quantity', 'UpdateDate']);

  // Quantity column RENAMED: refused, naming the column, nothing written.
  const renamed = [INV_HEAD.replace('Quantity', 'OnHand')];
  for (let i = 0; i < MIN_INVENTORY_ROWS + 5; i++) renamed.push(invLine(`Ship${i % 48}`, `P${i}`, 'FILLER', 3));
  const r1 = await ingestObpCsv(hon, [{ filename: CSV_FILES.inventory, content: renamed.join('\r\n') }], '2026-09-17');
  assert.ok(!r1.inventory, 'nothing written');
  assert.ok(/column\(s\) Quantity not in the header/.test(r1.refused[0] || ''), `refusal names the column: ${r1.refused[0]}`);

  // Quantity present but blank on most rows: refused.
  const blank = [INV_HEAD];
  for (let i = 0; i < MIN_INVENTORY_ROWS + 5; i++) blank.push(invLine(`Ship${i % 48}`, `P${i}`, 'FILLER', i % 2 ? '' : 3));
  const r2 = await ingestObpCsv(hon, [{ filename: CSV_FILES.inventory, content: blank.join('\r\n') }], '2026-09-17');
  assert.ok(!r2.inventory);
  assert.ok(/Quantity unreadable on \d+ of \d+ rows/.test(r2.refused[0] || ''), r2.refused[0]);

  // Every Quantity zero: refused.
  const zeros = [INV_HEAD];
  for (let i = 0; i < MIN_INVENTORY_ROWS + 5; i++) zeros.push(invLine(`Ship${i % 48}`, `P${i}`, 'FILLER', 0));
  const r3 = await ingestObpCsv(hon, [{ filename: CSV_FILES.inventory, content: zeros.join('\r\n') }], '2026-09-17');
  assert.ok(!r3.inventory);
  assert.ok(/every Quantity is 0 or blank/.test(r3.refused[0] || ''), r3.refused[0]);

  // A few blanks inside the tolerance are written as NULL, not 0.
  const few = [INV_HEAD];
  for (let i = 0; i < MIN_INVENTORY_ROWS + 5; i++) few.push(invLine(`Ship${i % 48}`, `P${i}`, 'FILLER', i < 10 ? '' : 3));
  const r4 = await ingestObpCsv(hon, [{ filename: CSV_FILES.inventory, content: few.join('\r\n') }], '2026-09-17');
  assert.equal(r4.refused.length, 0, r4.refused.join('; '));
  assert.equal(r4.inventory, MIN_INVENTORY_ROWS + 5);
  assert.ok(MAX_BLANK_SHARE <= 0.2);

  // In-transit with ShipProvDate renamed: refused naming it.
  const trRenamed = [TR_HEAD.replace('ShipProvDate', 'LandingDate'), trLine('Allure', 'P1', 'TONER', 6, '10/20/2026')];
  const r5 = await ingestObpCsv(hon, [{ filename: CSV_FILES.intransit, content: trRenamed.join('\r\n') }], '2026-09-17');
  assert.ok(/column\(s\) ShipProvDate not in the header/.test(r5.refused[0] || ''), r5.refused[0]);
  console.log('ok - obp csv: absent is null not zero; a renamed, blank or all-zero Quantity column is refused by name');
}
