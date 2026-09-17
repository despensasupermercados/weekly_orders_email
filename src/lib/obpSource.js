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

// A MIRROR THAT HAS NOT MOVED IS NOT FRESHER, WHATEVER ITS STAMP SAYS.
// snapshot_date is stamped at ingest and advances every morning whether or
// not a single value changed; that is exactly how the 10-16 Sep freeze read
// as "fresh" for six days. So a mirror snapshot whose row count and total
// equal the previous snapshot's is treated as stale: a CSV copy loaded the
// day before beats it. The moment the workbook is really refreshed the
// content differs, the mirror wins on date again, and the CSV copy steps
// back until the next one arrives.
// The mirror's EFFECTIVE date: the first snapshot date of its current
// content, i.e. the day it last actually changed. Comparing only the last two
// snapshots was not enough (review, 17 Sep 2026): a mirror that really moved
// on the 18th and was re-stamped unchanged on the 19th read as "frozen" and
// lost to a CSV copy from the 16th, two days older than its content.
async function effectiveDate(db, table, col) {
  try {
    const rows = (await db.prepare(
      `SELECT snapshot_date d, COUNT(*) n, ROUND(SUM(${col}), 2) s
         FROM ${table} GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 60`).all()).results || [];
    if (!rows.length) return null;
    let eff = rows[0].d;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].n === rows[0].n && rows[i].s === rows[0].s) eff = rows[i].d;
      else break;
    }
    return eff;
  } catch (_) {
    return null;
  }
}

export async function obpSource(hon) {
  const mirrorInv = await latest(hon, 'obp_inventory');
  const mirrorTr = await latest(hon, 'obp_intransit');
  const csvInv = (await columnsOf(hon, CSV_INVENTORY)) ? await latest(hon, CSV_INVENTORY) : null;
  const csvTr = (await columnsOf(hon, CSV_INTRANSIT)) ? await latest(hon, CSV_INTRANSIT) : null;

  // A mirror stamped after the CSV copy only wins if its CONTENT changed
  // after the CSV copy's date; a re-stamp of the same figures is not fresher.
  const invEff = csvInv && mirrorInv && csvInv < mirrorInv ? (await effectiveDate(hon, 'obp_inventory', 'on_hand')) || mirrorInv : mirrorInv;
  const trEff = csvTr && mirrorTr && csvTr < mirrorTr ? (await effectiveDate(hon, 'obp_intransit', 'qty')) || mirrorTr : mirrorTr;
  const mirrorInvFrozen = Boolean(mirrorInv && invEff && invEff < mirrorInv);
  const mirrorTrFrozen = Boolean(mirrorTr && trEff && trEff < mirrorTr);

  const useCsvInv = Boolean(csvInv) && (!mirrorInv || csvInv >= invEff);
  const useCsvTr = Boolean(csvTr) && (!mirrorTr || csvTr >= trEff);

  return {
    inventory: useCsvInv
      ? { source: 'csv', table: CSV_INVENTORY, latest: csvInv }
      : { source: 'mirror', table: 'obp_inventory', latest: mirrorInv },
    intransit: useCsvTr
      ? { source: 'csv', table: CSV_INTRANSIT, latest: csvTr, land: CSV_LAND, etaOk: CSV_ETA_OK, etaCol: 'eta_date' }
      : { source: 'mirror', table: 'obp_intransit', latest: mirrorTr, land: MIRROR_LAND, etaOk: MIRROR_ETA_OK, etaCol: 'eta' },
    mirror: { inventory: mirrorInv, intransit: mirrorTr, effective: { inventory: invEff, intransit: trEff },
      frozen: { inventory: mirrorInvFrozen, intransit: mirrorTrFrozen } },
    csv: { inventory: csvInv, intransit: csvTr },
  };
}
