// node tools/replay.mjs <dump-dir> <YYYY-MM-DD> [out.html]
//
// RE-RUN THE MONDAY EMAIL ON SAVED DATA. Loads JSON dumps of the tables
// fleetRunway() reads into an in-memory SQLite, runs THIS repo's own
// src/lib/runwayDb.js against them as of the given date, prints the findings
// as JSON on stdout and a count on stderr, and with out.html renders the
// fleet email the crews would get.
//
// What it is for: proving a rule change before it ships, on the data the
// fleet actually has, and scoring it against Ray's own verdicts. 12 Oct
// 2026: the replay reproduced his sample sheet. 19 Oct: it reproduced
// production's 26 rows exactly, then measured floor-model toner on a
// 6-month average (26 -> 18 rows, all five of his gaps kept). To test a
// variant, copy the repo, change the copy, run the COPY's tools/replay.mjs:
// it always imports the runwayDb.js beside it.
//
// The dump dir holds the D1 results as saved by the query tool (or bare
// arrays). Queries, all read-only, are in tools/README.md:
//   cons.json   consumption_snapshot   (cims-hon; the months you need)
//   inv.json    weekly_obp_inventory   (latest snapshot)
//   tr.json     weekly_obp_intransit   (latest snapshot)
//   par.json    par
//   sched.json  schedule_order
//   obp.json    weekly_obp_consumption (optional: Ray's monthly figures)
//   *.sql       optional INSERTs run after loading, e.g. tools/ray-export.mjs output
// Nothing here touches D1. It reads files and writes stdout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => pathToFileURL(path.join(here, '..', 'src', 'lib', f)).href;
const { DDL } = await import(src('obpCsv.js'));
const { fleetRunway } = await import(src('runwayDb.js'));
const { renderWeekly } = await import(src('email.js'));

const [dir, today, html] = process.argv.slice(2);
if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
  console.error('usage: node tools/replay.mjs <dump-dir> <YYYY-MM-DD> [out.html]');
  process.exit(2);
}

const db = new DatabaseSync(':memory:');
// cims-hon's tables, as their columns are read (this Worker never writes them).
db.exec(`
  CREATE TABLE consumption_snapshot (ship TEXT, part_number TEXT, month TEXT, on_hand REAL, receipts REAL);
  CREATE TABLE par (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, ship TEXT, brand TEXT, part_number TEXT, description TEXT, category TEXT, model TEXT, par_qty REAL, sku TEXT, source TEXT);
  CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, loading_port TEXT, loading_delivery_date TEXT, due_date TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);
  CREATE TABLE obp_inventory (ship TEXT, part_number TEXT, on_hand REAL, snapshot_date TEXT);
  CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty REAL, snapshot_date TEXT);
`);
// This Worker's own weekly_* tables, from the same DDL the Worker runs.
for (const sql of DDL) db.exec(sql);

const rowsOf = (file) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = Array.isArray(j) && j[0] && j[0].results ? j[0].results : j.results || j;
  if (!Array.isArray(x)) throw new Error(`${file}: expected an array of rows or a D1 result`);
  return x;
};
const load = (table, name, required = true) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) { if (required) throw new Error(`missing ${file}`); return 0; }
  const rs = rowsOf(file);
  if (!rs.length) return 0;
  const cols = Object.keys(rs[0]);
  const st = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rs) st.run(...cols.map((c) => r[c]));
  return rs.length;
};
const counts = {
  consumption_snapshot: load('consumption_snapshot', 'cons.json'),
  weekly_obp_inventory: load('weekly_obp_inventory', 'inv.json'),
  weekly_obp_intransit: load('weekly_obp_intransit', 'tr.json'),
  par: load('par', 'par.json'),
  schedule_order: load('schedule_order', 'sched.json'),
  weekly_obp_consumption: load('weekly_obp_consumption', 'obp.json', false),
};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
counts.weekly_obp_consumption = db.prepare('SELECT COUNT(*) n FROM weekly_obp_consumption').get().n;

// The D1 binding's shape, enough for fleetRunway.
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

const r = await fleetRunway(hon, today);
if (!r.ran && r.ran !== undefined) console.error(`fleetRunway did not run: ${r.reason}`);
const out = r.findings.map((f) => ({
  key: `${f.ship}|${f.item}`, on_hand: f.on_hand, rate: f.rate, last: f.rate_last, avg: f.rate_avg, source: f.rate_source,
  empty: f.stockout, next: f.next_loading, due: f.order_due, lands: f.order_lands, add: f.add_qty, basis: f.add_basis,
}));
console.log(JSON.stringify(out, null, 1));
if (html) fs.writeFileSync(html, renderWeekly([], [], today, { runsOut: r.findings, gaps: [], schedules: [], checked: [] }));
console.error(`loaded ${JSON.stringify(counts)}`);
console.error(`${out.length} findings as of ${today}; ${r.measured} items measured; usage source ${r.source?.consumption ?? 'n/a'}`);
