// Which copy of the OBP data to read.
//
// THE PROBLEM THIS SOLVES. The OBP figures reach cims-hon through an Excel
// workbook (OBPInventoryReporting.Linked.xlsx) that is emailed twice a day.
// That workbook is only a re-serving of three CSV exports written straight
// from the OBP database every night at 04:00 UTC into SharePoint
// (Inventory Reporting / Exports). The workbook's refresh from those CSVs is
// the unreliable stage: between 1 Aug and 16 Sep 2026 its inventory figures
// moved on five days out of forty-six, while the CSVs moved every night. On
// 16 Sep the mirror said Allure had 10 magenta aboard and the export said 17.
//
// So this Worker can also receive the CSVs themselves (see obpCsv.js) and keep
// its own copy. Every reader of OBP data goes through here and gets whichever
// copy is FRESHER - by snapshot date, and on a tie the CSV, because the CSV
// is the source and the workbook is a cache of it. If the CSV route ever
// stops, the mirror's date pulls ahead and the readers fall back on their own.
//
// Nothing here writes. The obp_* tables belong to cims-hon and stay untouched;
// the weekly_obp_* tables belong to this Worker.

import { columnsOf } from './schema.js';

export const CSV_INVENTORY = 'weekly_obp_inventory';
export const CSV_INTRANSIT = 'weekly_obp_intransit';

// obp_intransit.eta is an Excel serial in a TEXT column; the CSV copy stores a
// real ISO date. The readers ask the source for the expression, so neither
// spelling leaks into a query that then silently matches nothing.
const MIRROR_LAND = (a) => `date('1899-12-30', '+' || CAST(${a}.eta AS INTEGER) || ' days')`;
const MIRROR_ETA_OK = (a) => `${a}.eta GLOB '[0-9]*'`;
const CSV_LAND = (a) => `${a}.eta_date`;
const CSV_ETA_OK = (a) => `${a}.eta_date IS NOT NULL`;

async function latest(db, table) {
  try {
    const r = await db.prepare(`SELECT MAX(snapshot_date) d FROM ${table}`).first();
    return (r && r.d) || null;
  } catch (_) {
    return null;
  }
}

export async function obpSource(hon) {
  const mirrorInv = await latest(hon, 'obp_inventory');
  const mirrorTr = await latest(hon, 'obp_intransit');
  const csvInv = (await columnsOf(hon, CSV_INVENTORY)) ? await latest(hon, CSV_INVENTORY) : null;
  const csvTr = (await columnsOf(hon, CSV_INTRANSIT)) ? await latest(hon, CSV_INTRANSIT) : null;

  const useCsvInv = Boolean(csvInv) && (!mirrorInv || csvInv >= mirrorInv);
  const useCsvTr = Boolean(csvTr) && (!mirrorTr || csvTr >= mirrorTr);

  return {
    inventory: useCsvInv
      ? { source: 'csv', table: CSV_INVENTORY, latest: csvInv }
      : { source: 'mirror', table: 'obp_inventory', latest: mirrorInv },
    intransit: useCsvTr
      ? { source: 'csv', table: CSV_INTRANSIT, latest: csvTr, land: CSV_LAND, etaOk: CSV_ETA_OK, etaCol: 'eta_date' }
      : { source: 'mirror', table: 'obp_intransit', latest: mirrorTr, land: MIRROR_LAND, etaOk: MIRROR_ETA_OK, etaCol: 'eta' },
    mirror: { inventory: mirrorInv, intransit: mirrorTr },
    csv: { inventory: csvInv, intransit: csvTr },
  };
}
