// node test/sql.test.mjs
//
// Runs the REAL SQL from src/lib/due.js against a real SQLite, because the two
// worst bugs this file pins were invisible to a JavaScript fixture: they lived
// in the GROUP BY, not in classifyAll(). A fake database that returns whatever
// rows the test hands it can never catch a grouping mistake.

process.emitWarning = () => {}; // node:sqlite is experimental and says so loudly
const { DatabaseSync } = await import('node:sqlite');
const { voyageStates } = await import('../src/lib/due.js');
const assert = (await import('node:assert')).default;

// D1's surface over node:sqlite. Only what this Worker actually calls.
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

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE schedule_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ship TEXT, voyage TEXT, mot TEXT, cadence TEXT,
    loading_port TEXT, loading_delivery_date TEXT,
    total_lead_days INTEGER, due_date TEXT, must_be_in_ct_by TEXT,
    status TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER
  );
  CREATE TABLE obp_intransit (ship TEXT, eta TEXT, snapshot_date TEXT);
`);

const sched = db.prepare(`INSERT INTO schedule_order
  (ship, voyage, mot, loading_port, loading_delivery_date, due_date, source, po_number, po_state, date_changed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);

// THE BUG. saveAzamara() writes the PO number into `voyage`, and the PO is NULL
// exactly when po_state = 'none' - which IS the Azamara miss signal. SQLite
// groups NULLs together, so "GROUP BY ship, voyage" collapsed all three of
// Journey's un-PO'd loadings into ONE row carrying only the earliest due date.
// The miss signal was deleting its own evidence.
// The first is already past its cut-off, the other two are still ahead of it.
// Before the fix all three arrived here as one row carrying only 2026-09-01.
for (const [load, due] of [['2026-10-07', '2026-09-01'], ['2026-11-04', '2026-10-30'], ['2026-12-02', '2026-11-27']]) {
  sched.run('Journey', null, 'AZAMARA BWS', 'Miami', load, due, 'azamara-mls', null, 'none');
}

// A Royal ship on the real eligible MOT, with one loading covered by an open
// order and one not. Pins that RCCL/CEL are visible at all - they were not,
// for two days, because the filter said HOTEL MONTHLY.
sched.run('Odyssey', 'OD1234', 'HOTEL BIWEEKLY - HOTEL', 'Barcelona', '2026-09-20', '2026-09-05', 'ordering-schedule', null, null);
sched.run('Odyssey', 'OD1235', 'HOTEL BIWEEKLY - HOTEL', 'Barcelona', '2026-11-20', '2026-11-05', 'ordering-schedule', null, null);

// A schedule row with NO due date. days_to_due comes back NULL, and `null <= 7`
// is true in JavaScript, so this used to be classified DUE NOW and mailed to a
// crew as "Order due" with the date rendered as an empty string.
sched.run('Ghost', 'GH1', 'HOTEL BIWEEKLY HOTEL', 'Lisbon', '2026-11-25', null, 'ordering-schedule', null, null);

// A row on somebody else's supply stream must never appear.
sched.run('Odyssey', 'OD9999', 'WINE MONTHLY', 'Barcelona', '2026-09-20', '2026-09-05', 'email', null, null);

// obp_intransit.eta is an EXCEL SERIAL IN A TEXT COLUMN. 46281 is 2026-09-20.
const serial = (isoDate) => String(Math.round((Date.parse(isoDate) - Date.UTC(1899, 11, 30)) / 86400000));
const it = db.prepare('INSERT INTO obp_intransit (ship, eta, snapshot_date) VALUES (?, ?, ?)');
for (let i = 0; i < 11; i++) it.run('Odyssey', serial('2026-09-20'), '2026-09-09');

const states = await voyageStates(d1(db), '2026-09-09');
const journey = states.filter((s) => s.ship === 'Journey');

assert.equal(journey.length, 3,
  `all three of Journey's un-PO'd loadings must survive the GROUP BY, got ${journey.length}`);
assert.deepEqual(journey.map((s) => s.due_date).sort(),
  ['2026-09-01', '2026-10-30', '2026-11-27'],
  'each loading must keep its OWN due date, not the earliest one three times');

// The hyphenated MOT variant, and the ordered/unordered split via the Excel
// serial join. Getting the serial comparison wrong matches nothing, silently.
const odyssey = states.filter((s) => s.ship === 'Odyssey');
assert.equal(odyssey.length, 2, 'HOTEL BIWEEKLY - HOTEL must be eligible despite the hyphen');
assert.equal(odyssey.find((s) => s.loading_delivery_date === '2026-09-20').order_lines, 11,
  'the ETA serial join must match - a zero here means the date maths broke');
assert.equal(odyssey.find((s) => s.loading_delivery_date === '2026-11-20').order_lines, 0);

// Another department's stream must not be visible at all.
assert.ok(!states.some((s) => s.mot === 'WINE MONTHLY'), 'out-of-scope MOTs must never be selected');

// A voyage with no due date is an ingest fault, not a crew warning.
const ghost = states.find((s) => s.ship === 'Ghost');
assert.equal(ghost.state, 'NO_DUE_DATE',
  `a voyage with no due date must never be actionable, got ${ghost.state}`);

// And the miss note explains WHY, from the row itself.
const explained = journey.filter((j) => j.miss_note);
assert.ok(explained.length, 'a missed voyage must carry an explanation, not just a count');
assert.ok(explained[0].miss_note.includes('no PO'), 'the Azamara note must name the PO state');
assert.ok(explained[0].miss_note.includes('past the cut-off'), 'the note must say how late it is');

console.log(`ok - real SQL: ${journey.length} Journey loadings survive the GROUP BY (was 1),`);
console.log('     the Excel-serial join matches, out-of-scope MOTs stay invisible,');
console.log('     and a voyage with no due date never reaches a ship');
