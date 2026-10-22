// node test/floorModelRate.test.mjs
//
// FLOOR-MODEL TONER PLANS ON SIX MONTHS; EVERYTHING ELSE ON LAST MONTH.
// Ray, 22 Oct 2026: "yes. six month average would work better for the floor
// models toners." His 19 Oct spot check had called 14 floor-model rows okay at
// about 1 a month where the email planned on OBP's last month, 2 to 5. Runs the
// REAL query in src/lib/runwayDb.js against SQLite, one ship per case, so each
// case stands or falls on its own rule.

import assert from 'node:assert';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { DDL } = await import('../src/lib/obpCsv.js');
const { fleetRunway } = await import('../src/lib/runwayDb.js');
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

const today = '2026-10-19';
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
// One ship per case; one item each; 1 aboard, nothing in transit, the next
// order lands 1 Feb, so every item runs dry before it and is a finding.
function item(ship, part, description, counts, receipts, obpSep, { onHand = 1, brand = 'Azamara', par = 5 } = {}) {
  counts.forEach((c, i) => {
    if (c == null) return; // a month with no count on file
    db.prepare('INSERT INTO consumption_snapshot VALUES (?,?,?,?,?)').run(ship, part, MONTHS[i], c, receipts[i] ?? 0);
  });
  db.prepare('INSERT INTO par (scope, ship, brand, part_number, description, par_qty) VALUES (?,?,?,?,?,?)').run('ship', ship, brand, part, description, par);
  db.prepare("INSERT INTO weekly_obp_inventory (ship, part_number, description, on_hand, snapshot_date, source) VALUES (?,?,?,?,?, 'csv')").run(ship, part, description, onHand, today);
  if (obpSep != null) {
    db.prepare("INSERT INTO weekly_obp_consumption (ship, part_number, description, month, usage, source) VALUES (?,?,?, '2026-09', ?, 'ray-export')").run(ship, part, description, obpSep);
  }
  db.prepare("INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date, source) VALUES (?, 'V1', 'AZAMARA BWS', '2027-02-01', '2026-11-30', 'azamara-mls')").run(ship);
}
db.prepare("INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES ('Elsewhere', 'X', 1, '2027-03-01', ?, 'csv')").run(today);

// A. Quest TN324BK, the 19 Oct case: OBP says 4 last month; six months of
// counts say 1 (4 at end of March, 6 received, 4 at end of September).
item('A', 'A8DA130', 'TN324BK BLACK TONER', [4, 3, 6, 5, 4, 5, 4], [0, 0, 4, 0, 0, 2, 0], 4);
// B. Paper beside it: last month stays the rule.
item('B', '8.5 x 11 / 99PRD75632', '20 LBS 8.5 x 11 DG3 PAPER', [40, 30, 50, 40, 30, 40, 30], [0, 0, 40, 0, 0, 40, 0], 12, { onHand: 5 });
// C. Floor-model with only four months on file (WX-103 on 19 Oct): last month.
item('C', 'A4NN0Y2', 'WASTE TONER BOX WX-103', [null, null, null, 3, 1, 1, 1], [0, 0, 0, 0, 0, 2, 0], 2);
// D. Floor-model whose window nets below zero (the end count is a miscount): last month.
item('D', 'ACF0033', 'TNP75 BLACK TONER BH 5000i (YIELD: 13K)', [2, 2, 2, 2, 2, 2, 9], [0, 0, 0, 0, 0, 0, 0], 3);
// E. Floor-model used in spring, idle since: last month and the average read 0,
// so it used to drop out; six months say 0.5 and it is judged.
item('E', 'AAV8430', 'TN-328C CYAN TONER', [5, 4, 3, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0], 0, { onHand: 0 });
// F. C4070 toner with the same counts as A: last month (+3 spare rule untouched).
item('F', 'A3VX430 / 99PRD67088', 'TN619C CYAN TONER', [4, 3, 6, 5, 4, 5, 4], [0, 0, 4, 0, 0, 2, 0], 4, { brand: 'RCCL' });
// G. The C4070 waste box is not a floor-model bottle: last month.
item('G', 'A50UR70115 - 99PRD67080', 'WASTE TONER BOX (DG3)', [4, 3, 6, 5, 4, 5, 4], [0, 0, 4, 0, 0, 2, 0], 4, { brand: 'RCCL', par: 12 });
// I. Floor-model with June missing from the counts: June's receipts are
// unknown, so the window cannot be trusted. Last month.
item('I', 'A9E8330', 'TN514M MAGENTA TONER', [4, 3, 6, null, 4, 5, 4], [0, 0, 4, 0, 0, 2, 0], 3);
// J. Onward's floor-model waste box ("WASTE TONER BOX", no "(DG3)") with full
// history: a floor-model bottle, so six months, like the toner.
item('J', 'AAVA0Y1', 'WASTE TONER BOX', [4, 3, 6, 5, 4, 5, 4], [0, 0, 4, 0, 0, 2, 0], 4);
// H. A six-month figure with a decimal: 10 used over 6 months.
item('H', 'A9E8430', 'TN514C CYAN TONER', [12, 11, 9, 8, 6, 4, 2], [0, 0, 0, 0, 0, 0, 0], 2);

const r = await fleetRunway(hon, today);
assert.equal(r.ran, true, r.reason);
const by = Object.fromEntries(r.findings.map((f) => [f.ship, f]));
assert.deepEqual(Object.keys(by).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], 'every case is judged and runs dry before 1 Feb');

assert.equal(by.A.rate, 1, 'floor-model: six months of counts, not OBP\'s 4');
assert.equal(by.A.rate_six, 1);
assert.equal(by.A.rate_last, 4, 'last month still carried, to print beside it');
assert.equal(by.B.rate, 12, 'paper plans on last month');
assert.equal(by.B.rate_six, null);
assert.equal(by.C.rate, 2, 'four months of counts: no six-month figure, last month');
assert.equal(by.C.rate_six, null);
assert.equal(by.D.rate, 3, 'a window that nets below zero is a miscount, not a rate: last month');
assert.equal(by.D.rate_six, null);
assert.ok(Math.abs(by.E.rate - 0.5) < 1e-9, 'idle since spring: judged at 0.5, not dropped');
assert.equal(by.F.rate, 4, 'C4070 toner plans on last month');
assert.equal(by.F.rate_six, null);
assert.equal(by.G.rate, 4, 'the C4070 waste box is not a floor-model bottle');
assert.equal(by.G.rate_six, null);
assert.equal(by.J.rate, 1, 'a floor-model waste box plans on six months');
assert.equal(String(by.J.add_basis).startsWith('OBP par is 5'), true, 'and still tops up to the OBP par');
assert.equal(by.I.rate, 3, 'a month missing inside the window: last month');
assert.equal(by.I.rate_six, null);
assert.ok(Math.abs(by.H.rate_six - 10 / 6) < 1e-9, '10 used over six months');
assert.equal(by.H.rate, 1.7, 'carried to one decimal, as every rate is');

// The email names the rule it used and keeps the decimal.
const html = renderWeekly([], [], today, { runsOut: r.findings, gaps: [], schedules: [], checked: [] });
const text = html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
assert.ok(text.includes('1 a month over 6 months · 4 last month (OBP) · we plan on the 6-month average'), 'A names the six-month rule');
assert.ok(text.includes('1.7 a month over 6 months · 2 last month (OBP) · we plan on the 6-month average'), 'H keeps one decimal');
assert.ok(text.includes('you use 1.7 a month'), 'the headline carries the same figure as the line below it');
assert.ok(text.includes('you use 0.5 a month'), 'a slow item never reads "you use 0 a month"');
assert.ok(!/12 last month[^·]*· we plan on the 6-month/.test(text), 'paper never claims the six-month rule');

console.log('ok - floor-model toner plans on six months of counts; paper, C4070 toner, the C4070 waste box, short history and a miscount stay on last month');
