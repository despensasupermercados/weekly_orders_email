// node test/rayExport.test.mjs
//
// RAY'S EXPORT LOADS ONLY WHEN IT IS A COMPLETE MONTH. tools/ray-export.mjs
// writes his Usage into weekly_obp_consumption, which becomes the planning
// rate. On 14 Oct 2026 he sent October 1-14 as "Nov start"; loaded, half a
// month would have been planned on as a whole one. Each guard below is
// pinned by a case that fails without it.

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { buildLoad, mapSheets, readSheets, MIN_SEEN } from '../tools/ray-export.mjs';

const XLSX = createRequire(import.meta.url)('xlsx');
const HEAD = ['Part/Supply Number', 'Description', 'Beginning Inventory', 'Inventory Additions', 'Ending Inventory', 'Usage / Consumption'];

// One ship's stock: 8 consumables and 2 parts whose names carry PAPER and
// TONER (the exclusion is what keeps them out), distinct counts per ship so a
// sheet can only match its own ship.
const stock = (n) => [
  ...Array.from({ length: 8 }, (_, i) => [`T${i}`, i === 0 ? "TN619C CYAN TONER (Ray's)" : `TONER ${i}`, 10 + n, 2, n * 3 + i, 12 + n - (n * 3 + i)]),
  ['R1', 'PAPER FEED ROLLER', 4, 0, 40 + n, 0],
  ['K1', 'TONER CARTRIDGE KIT', 4, 0, 50 + n, 0],
];
const openFor = (ship, n) => stock(n).map((r) => ({ ship, part_number: r[0], on_hand: r[4] }));
const book = (sheets) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary']]), 'Summary');
  for (const [code, rows, head = HEAD] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), code);
  return wb;
};
const ships = Array.from({ length: 10 }, (_, i) => [`S${i}`, `Ship${i}`, i + 1]);
const monthOpen = ships.flatMap(([, ship, n]) => openFor(ship, n));
const complete = () => [{ file: 'royal.xlsx', wb: book(ships.map(([code, , n]) => [code, stock(n)])) }];

// 1. A complete month: every sheet maps to its ship, consumables only, values carried.
{
  const r = buildLoad({ workbooks: complete(), monthOpen, month: '2026-10' });
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.rows, 80, 'eight consumables per ship; a paper feed roller and a toner kit are parts');
  assert.equal(r.ships, 10);
  const sql = r.sql.join('\n');
  assert.ok(sql.includes("('Ship0','T0','TN619C CYAN TONER (Ray''s)','2026-10',11,2,3,10,'ray-export')"), 'quote doubled, every figure carried');
  assert.ok(!/FEED ROLLER|CARTRIDGE KIT/.test(sql));
  assert.ok(sql.startsWith('INSERT OR REPLACE INTO weekly_obp_consumption'), 'a re-run replaces, it does not duplicate');
}

// 2. A month in progress: Endings are a mid-month count, not the next 1st's. Refused, nothing written.
{
  const mid = [{ file: 'royal.xlsx', wb: book(ships.map(([code, , n]) => [code, stock(n).map((r) => [r[0], r[1], r[2], r[3], r[4] + 1, r[5]])])) }];
  const r = buildLoad({ workbooks: mid, monthOpen, month: '2026-10' });
  assert.ok(r.refused && /month in progress/.test(r.refused), 'a month-to-date file is refused');
  assert.equal(r.sql, undefined, 'and nothing is written');
}

// 3. One sheet that does not map (Hero: two rows) does not stop a complete
// month. Its two Endings equal Ship0's counts, as Hero's equalled Adventure's
// in September (2 of 2): too few rows to be a match, so Ship0 keeps its sheet.
{
  const wbs = complete();
  XLSX.utils.book_append_sheet(wbs[0].wb, XLSX.utils.aoa_to_sheet([HEAD, ['T0', 'TONER', 3, 0, 3, 0], ['T1', 'TONER', 4, 0, 4, 0]]), 'HE');
  const r = buildLoad({ workbooks: wbs, monthOpen, month: '2026-10' });
  assert.equal(r.refused, undefined, r.refused);
  assert.ok(r.report.some((l) => /HE -> NOT MAPPED/.test(l)), `fewer than ${MIN_SEEN} rows is not a match`);
  assert.equal(r.rows, 80);
}

// 4. Two sheets matching one ship map neither.
{
  const { rows } = readSheets([{ file: 'royal.xlsx', wb: book([['S0', stock(1)], ['S9', stock(1)], ['S1', stock(2)]]) }]);
  const { map, report } = mapSheets(rows, monthOpen);
  assert.equal(map.get('royal.xlsx|S0'), null);
  assert.equal(map.get('royal.xlsx|S9'), null);
  assert.equal(map.get('royal.xlsx|S1'), 'Ship1');
  assert.ok(report.some((l) => l.startsWith('CONFLICT')));
}

// 4b. A sheet that matches two ships equally (a hull seeded with another's
// counts) maps to neither: a tie is not a match.
{
  const twin = [...monthOpen, ...openFor('Twin', 2)];
  const { rows } = readSheets([{ file: 'royal.xlsx', wb: book([['S1', stock(2)]]) }]);
  const { map, report } = mapSheets(rows, twin);
  assert.equal(map.get('royal.xlsx|S1'), null);
  assert.ok(report.some((l) => /S1 -> NOT MAPPED/.test(l)));
}

// 5. A sheet with other headers is named, never guessed at.
{
  const { rows, skipped } = readSheets([{ file: 'cel.xlsx', wb: book([['SL', stock(1), ['Part', 'Desc', 'Qty']]]) }]);
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].startsWith('cel.xlsx SL'));
}

// 6. Inputs that cannot be right are refused.
{
  assert.ok(/YYYY-MM/.test(buildLoad({ workbooks: complete(), monthOpen, month: 'October' }).refused));
  assert.ok(/no rows/.test(buildLoad({ workbooks: complete(), monthOpen: [], month: '2026-10' }).refused));
}

console.log('ok - ray export: a complete month loads consumables only; a month in progress, a conflict, a stranger sheet and bad inputs write nothing');
