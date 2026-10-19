// node tools/ray-export.mjs <folder> <YYYY-MM> <month-open.json> [out.sql]
//
// RAY'S MONTHLY OBP EXPORT -> weekly_obp_consumption.
//
// Ray sends one workbook per brand (Azamara, Royal, Celebrity), one sheet per
// ship named by a two-letter OBP code, with Part/Supply Number, Description,
// Beginning Inventory, Inventory Additions, Ending Inventory and Usage. The
// email plans on his Usage figure (runwayDb.js, obpm), so this is how a month
// gets into the planning rate. September 2026 was loaded by a one-off script
// that lived only in a session scratchpad; this is that script made permanent
// (Miguel, 24 Sep: everything a session depends on lives in the repo).
//
// WHICH SHEET IS WHICH SHIP. The codes are not in our data. A sheet is matched
// to the ship whose month-open count equals its Ending Inventory on the most
// rows: Ending of month M is OBP's count on the 1st of M+1, which this Worker
// keeps in weekly_obp_month_open (RAY-LOGIC.md 4.1: 44 of 44 rows, 48 of 48
// ships by code). The month-open file is that table for the 1st AFTER the
// month being loaded - for October, snapshot_date '2026-11-01':
//   SELECT ship, part_number, on_hand FROM weekly_obp_month_open
//    WHERE snapshot_date = '2026-11-01'
// saved as JSON (the D1 tool's output as it comes, or a bare array).
//
// A MONTH IN PROGRESS IS REFUSED, NOT LOADED. On 14 Oct Ray sent October 1-14
// under the name "Nov start OBP.xlsx". Loaded, half a month of usage would have
// become the planning rate on 1 Nov. Its Ending is a mid-month count, so it
// does not equal the month-open and no sheet maps; when too few sheets map the
// whole file is refused and nothing is written. This is the guard that matters.
// Measured 19 Oct on Ray's real files against the 1 Oct month-open: the
// complete September export mapped 48 of 49 sheets, the worst at 42 of 43
// rows (98%); the 1-14 Oct file mapped none, the best at 88 of 109 (81%).
// MIN_SHARE sits between the two. HE (Hero, not in service) has 2 rows and
// never maps; that is expected, not a fault.
//
// Only consumables are written (the same filter as the September load); the
// output is INSERT OR REPLACE, so re-running a month replaces it, and a
// complete export replaces rows computed as a fallback (source 'computed').

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const XLSX = createRequire(import.meta.url)('xlsx');

export const CONSUMABLE = /TONER|PAPER|CARD STOCK|GLOSS|RADIANT/i;
export const NOT_CONSUMABLE = /FEED|ROLLER|KIT/i;
export const MIN_SHARE = 0.9;   // of a sheet's rows found aboard the ship, how many Endings must equal its count
export const MIN_SEEN = 5;      // a sheet matched on fewer rows than this is not matched at all
export const MIN_MAPPED = 0.9;  // of the sheets, how many must map before anything is written

const HEADERS = { part: 'part', description: 'description', begin: 'beginning', add: 'inventory add', end: 'ending', usage: 'usage' };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Rows from workbooks: { file, code, part_number, description, begin, add, end, usage }.
// A sheet whose headers do not match is named in `skipped`, never guessed at.
export function readSheets(workbooks) {
  const rows = [];
  const skipped = [];
  for (const { file, wb } of workbooks) {
    for (const code of wb.SheetNames) {
      if (/^summary$/i.test(code.trim())) continue;
      const a = XLSX.utils.sheet_to_json(wb.Sheets[code], { header: 1, defval: '' });
      if (!a.length) continue;
      const h = a[0].map((x) => String(x).trim().toLowerCase());
      const ix = Object.fromEntries(Object.entries(HEADERS).map(([k, p]) => [k, h.findIndex((x) => x.startsWith(p))]));
      if (Object.values(ix).some((i) => i < 0)) { skipped.push(`${file} ${code}: headers ${JSON.stringify(a[0])}`); continue; }
      for (const r of a.slice(1)) {
        const part = String(r[ix.part] ?? '').trim();
        if (!part && !String(r[ix.description] ?? '').trim()) continue;
        rows.push({
          file, code: code.trim(), part_number: part, description: String(r[ix.description] ?? '').trim(),
          begin: num(r[ix.begin]), add: num(r[ix.add]), end: num(r[ix.end]), usage: num(r[ix.usage]),
        });
      }
    }
  }
  return { rows, skipped };
}

// Map each sheet code to a ship by Ending = month-open count. A code is mapped
// only on a clear winner; two codes claiming one ship map neither.
export function mapSheets(rows, monthOpen) {
  const open = new Map(monthOpen.map((r) => [`${r.ship}|${String(r.part_number).trim()}`, Number(r.on_hand)]));
  const ships = [...new Set(monthOpen.map((r) => r.ship))];
  const codes = [...new Set(rows.map((r) => `${r.file}|${r.code}`))];
  const result = new Map();
  const report = [];
  for (const key of codes) {
    const rs = rows.filter((r) => `${r.file}|${r.code}` === key);
    const scored = ships.map((ship) => {
      let hit = 0, seen = 0;
      for (const r of rs) {
        const v = open.get(`${ship}|${r.part_number}`);
        if (v == null || r.end == null) continue;
        seen++;
        if (v === r.end) hit++;
      }
      return { ship, hit, seen };
    }).sort((a, b) => b.hit - a.hit || b.seen - a.seen);
    const [best, next] = scored;
    const ok = best && best.seen >= MIN_SEEN && best.hit / best.seen >= MIN_SHARE && (!next || next.hit < best.hit);
    result.set(key, ok ? best.ship : null);
    report.push(`${key.replace('|', ' ')} -> ${ok ? best.ship : 'NOT MAPPED'} (${best ? `${best.hit}/${best.seen}` : '0/0'} endings equal the month-open, ${rs.length} rows${best && !ok ? `; best guess ${best.ship}` : ''})`);
  }
  const claims = new Map();
  for (const [key, ship] of result) if (ship) claims.set(ship, [...(claims.get(ship) || []), key]);
  for (const [ship, keys] of claims) {
    if (keys.length < 2) continue;
    for (const k of keys) result.set(k, null);
    report.push(`CONFLICT: ${keys.join(', ')} all match ${ship}; none mapped`);
  }
  return { map: result, report };
}

const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// Everything the CLI does, minus the file system: returns the SQL statements,
// or refuses with the reason. `refused` set means nothing may be written.
export function buildLoad({ workbooks, monthOpen, month, batch = 100 }) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return { refused: `month must be YYYY-MM, got ${month}` };
  if (!monthOpen.length) return { refused: 'the month-open file has no rows' };
  const { rows, skipped } = readSheets(workbooks);
  if (!rows.length) return { refused: 'no rows read from the workbooks', skipped };
  const { map, report } = mapSheets(rows, monthOpen);
  const mapped = [...map.values()].filter(Boolean).length;
  if (mapped / map.size < MIN_MAPPED) {
    return {
      refused: `${mapped} of ${map.size} sheets match the month-open. A complete month's Ending equals the next 1st's count; ` +
        'this file is a month in progress, the wrong month, or the wrong month-open. Nothing written.',
      report, skipped,
    };
  }
  const out = [];
  const bad = [];
  for (const r of rows) {
    const ship = map.get(`${r.file}|${r.code}`);
    if (!ship || !CONSUMABLE.test(r.description) || NOT_CONSUMABLE.test(r.description)) continue;
    if (r.usage == null) { bad.push(`${ship} ${r.part_number}: no usage figure`); continue; }
    out.push([ship, r.part_number, r.description, month, r.begin, r.add, r.end, r.usage, 'ray-export']);
  }
  const sql = [];
  for (let i = 0; i < out.length; i += batch) {
    sql.push('INSERT OR REPLACE INTO weekly_obp_consumption (ship, part_number, description, month, begin_qty, additions, end_qty, usage, source) VALUES\n' +
      out.slice(i, i + batch).map((v) => `(${v.map(q).join(',')})`).join(',\n') + ';');
  }
  return { sql, rows: out.length, ships: new Set(out.map((v) => v[0])).size, report, skipped, bad };
}

function loadJsonRows(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = Array.isArray(j) && j[0] && j[0].results ? j[0].results : j.results || j;
  if (!Array.isArray(x)) throw new Error(`${file}: expected an array of rows or a D1 result`);
  return x;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, month, openFile, outFile] = process.argv.slice(2);
  if (!dir || !month || !openFile) {
    console.error('usage: node tools/ray-export.mjs <folder of .xlsx> <YYYY-MM> <month-open.json> [out.sql]');
    process.exit(2);
  }
  const workbooks = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f)).sort()
    .map((f) => ({ file: f, wb: XLSX.readFile(path.join(dir, f)) }));
  const r = buildLoad({ workbooks, monthOpen: loadJsonRows(openFile), month });
  for (const line of r.report || []) console.error(line);
  for (const s of r.skipped || []) console.error(`SKIPPED ${s}`);
  if (r.refused) { console.error(`REFUSED: ${r.refused}`); process.exit(1); }
  for (const b of r.bad) console.error(`NOT LOADED ${b}`);
  const text = r.sql.join('\n\n') + '\n';
  if (outFile) fs.writeFileSync(outFile, text); else process.stdout.write(text);
  console.error(`${r.rows} consumable rows for ${r.ships} ships, month ${month}, in ${r.sql.length} statement(s)`);
}
