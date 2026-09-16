// The OBP CSV exports, read straight from the email they arrive in.
//
// Three files are written from the OBP database every night at 04:00 UTC into
// SharePoint / OnboardPrintAdmin / Inventory Reporting / Exports:
//   onboardinventory.csv     what is aboard each ship
//   intransititems.csv       every open order line and the day it lands
//   acceptedorderdetails.csv receipts (not used by this Worker yet)
// The Power Automate flow "OBP nightly" attaches them and mails them to
// obp-csv@cims.work, which routes here. Column names are the export's own,
// checked against the live files on 16 Sep 2026:
//   inventory: ShipName,UpdateDate,PartID,PartCategory,PartNumber,PartDescr,
//              PartsSortOrder,Quantity,PartPrice,Total Price,InventoryID,
//              CustomerName,Supplier
//   intransit: ShipName,OrdersID,PONumber,VendorInvoiceNumber,OrderDate,
//              PlacedBy,VoyageNum,ShipProvPort,ShipProvDate,PartID,PartCategory,
//              PartNumber,PartDescr,Quantity,PartPrice,Total Price,CustomerName,
//              Supplier
// ShipProvDate is the landing date ("9/18/2026 12:00:00 AM"), the same fact
// obp_intransit.eta carries as an Excel serial.
//
// These tables are THIS WORKER'S. The obp_* mirror belongs to cims-hon and is
// never written here; obpSource.js decides which copy the readers use.

import { CSV_INVENTORY, CSV_INTRANSIT } from './obpSource.js';
import { columnsOf } from './schema.js';

export const CSV_FILES = {
  inventory: 'onboardinventory.csv',
  intransit: 'intransititems.csv',
  orders: 'acceptedorderdetails.csv',
};

// A fleet-wide inventory export is ~3,500 rows. A file a tenth of that size is
// a truncated download or the wrong file, and writing it would make most of
// the fleet read as empty. Refuse, log, keep yesterday's copy.
export const MIN_INVENTORY_ROWS = 1000;
export const KEEP_DAYS = 14;

// RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, a BOM if Excel put
// one there. Returns objects keyed by the header row, headers trimmed.
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) return [];
  const head = nonEmpty[0].map((h) => String(h).trim());
  return nonEmpty.slice(1).map((r) => {
    const o = {};
    head.forEach((h, k) => { o[h] = r[k] == null ? '' : String(r[k]).trim(); });
    return o;
  });
}

// "9/18/2026 12:00:00 AM", "01/29/24  7:07:32 PM", "2026-09-18" -> ISO date.
// Anything else is null: a date we cannot read must never become a date we
// guessed.
export function usDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function isObpCsvMail(names, subject = '') {
  const n = String(names || '').toLowerCase();
  return Object.values(CSV_FILES).some((f) => n.includes(f)) ||
    (/\bobp\b/i.test(String(subject || '')) && /\.csv\b/i.test(n));
}

export function mapInventory(rows, snapshotDate) {
  return rows
    .map((r) => ({
      ship: r.ShipName,
      part_number: r.PartNumber,
      description: r.PartDescr || null,
      category: r.PartCategory || null,
      on_hand: num(r.Quantity),
      update_date: usDate(r.UpdateDate),
      snapshot_date: snapshotDate,
    }))
    .filter((r) => r.ship && r.part_number);
}

export function mapIntransit(rows, snapshotDate) {
  return rows
    .map((r) => ({
      ship: r.ShipName,
      part_number: r.PartNumber,
      description: r.PartDescr || null,
      qty: num(r.Quantity),
      po_number: r.PONumber || null,
      vendor_invoice: r.VendorInvoiceNumber || null,
      voyage: r.VoyageNum || null,
      port: r.ShipProvPort || null,
      eta_date: usDate(r.ShipProvDate),
      order_date: usDate(r.OrderDate),
      snapshot_date: snapshotDate,
    }))
    .filter((r) => r.ship && r.part_number);
}

export const DDL = [
  // source: 'csv' for a row from the export, 'mirror-fill' for a ship the
  // export did not cover, copied from the workbook mirror so that ship keeps
  // its best-known figures instead of reading as empty. See fillFromMirror.
  `CREATE TABLE IF NOT EXISTS ${CSV_INVENTORY} (
     ship TEXT NOT NULL, part_number TEXT NOT NULL, description TEXT, category TEXT,
     on_hand REAL, update_date TEXT, snapshot_date TEXT NOT NULL, source TEXT,
     PRIMARY KEY (ship, part_number, snapshot_date))`,
  `CREATE TABLE IF NOT EXISTS ${CSV_INTRANSIT} (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ship TEXT NOT NULL, part_number TEXT NOT NULL, description TEXT, qty REAL,
     po_number TEXT, vendor_invoice TEXT, voyage TEXT, port TEXT,
     eta_date TEXT, order_date TEXT, snapshot_date TEXT NOT NULL, source TEXT)`,
  `CREATE INDEX IF NOT EXISTS ${CSV_INTRANSIT}_snap ON ${CSV_INTRANSIT} (snapshot_date, ship)`,
];

export async function ensureTables(hon) {
  for (const sql of DDL) await hon.prepare(sql).run();
}

// D1 has batch(); the SQLite stand-in in the tests may not. Either way every
// statement runs, and a missing batch() is not a reason to write nothing.
async function runAll(hon, stmts) {
  if (!stmts.length) return;
  if (typeof hon.batch === 'function') {
    for (let i = 0; i < stmts.length; i += 50) await hon.batch(stmts.slice(i, i + 50));
  } else {
    for (const s of stmts) await s.run();
  }
}

async function replaceSnapshot(hon, table, records, snapshotDate, cols) {
  await hon.prepare(`DELETE FROM ${table} WHERE snapshot_date = ?`).bind(snapshotDate).run();
  const ph = cols.map(() => '?').join(',');
  const ins = hon.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${ph})`);
  await runAll(hon, records.map((r) => ins.bind(...cols.map((c) => r[c] ?? null))));
  await hon.prepare(`DELETE FROM ${table} WHERE snapshot_date < date(?, '-${KEEP_DAYS} day')`).bind(snapshotDate).run();
}

const INV_COLS = ['ship', 'part_number', 'description', 'category', 'on_hand', 'update_date', 'snapshot_date', 'source'];
const TR_COLS = ['ship', 'part_number', 'description', 'qty', 'po_number', 'vendor_invoice', 'voyage', 'port', 'eta_date', 'order_date', 'snapshot_date', 'source'];

// A SHIP THE EXPORT DID NOT COVER KEEPS ITS MIRROR FIGURES. The readers pick
// the CSV table by snapshot date for the whole fleet, so a snapshot that
// carries half the ships would make the other half read as nothing aboard
// and nothing coming - a false stockout for every one of them. Every ship
// absent from the snapshot is copied in from the mirror's latest snapshot,
// marked 'mirror-fill'. On a complete export this writes nothing. On 16 Sep
// 2026 it is what made a half-file (the connector cuts at 200,000 characters)
// worth loading at all: 22 ships fresh, the rest as good as before.
export async function fillFromMirror(hon, snapshotDate) {
  // The mirror's optional columns are cims-hon's to name; read them only if
  // they exist rather than fail the whole fill over a description.
  const col = (cols, name) => (cols && cols.has(name) ? `m.${name}` : 'NULL');
  const ic = await columnsOf(hon, 'obp_inventory');
  const tc = await columnsOf(hon, 'obp_intransit');
  if (!ic || !tc) return { inventory: 0, intransit: 0, reason: 'mirror tables not found' };
  const inv = await hon.prepare(
    `INSERT OR REPLACE INTO ${CSV_INVENTORY} (ship, part_number, description, category, on_hand, update_date, snapshot_date, source)
     SELECT m.ship, m.part_number, ${col(ic, 'description')}, ${col(ic, 'category')}, m.on_hand, NULL, ?1, 'mirror-fill'
       FROM obp_inventory m
      WHERE m.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_inventory)
        AND m.ship NOT IN (SELECT DISTINCT ship FROM ${CSV_INVENTORY} WHERE snapshot_date = ?1)`).bind(snapshotDate).run();
  const tr = await hon.prepare(
    `INSERT INTO ${CSV_INTRANSIT} (ship, part_number, description, qty, po_number, vendor_invoice, voyage, port, eta_date, order_date, snapshot_date, source)
     SELECT m.ship, m.part_number, ${col(tc, 'description')}, m.qty, ${col(tc, 'po_number')}, ${col(tc, 'vendor_invoice')}, NULL, NULL,
            CASE WHEN m.eta GLOB '[0-9]*' THEN date('1899-12-30', '+' || CAST(m.eta AS INTEGER) || ' days') END,
            NULL, ?1, 'mirror-fill'
       FROM obp_intransit m
      WHERE m.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
        AND m.ship NOT IN (SELECT DISTINCT ship FROM ${CSV_INTRANSIT} WHERE snapshot_date = ?1)`).bind(snapshotDate).run();
  const n = (r) => (r && r.meta && typeof r.meta.changes === 'number') ? r.meta.changes : (r && typeof r.changes === 'number' ? r.changes : null);
  return { inventory: n(inv), intransit: n(tr) };
}

const textOf = (a) => {
  if (a.content && a.content.length) return a.content;
  if (a.bytes) return new TextDecoder('utf-8').decode(a.bytes);
  return '';
};

// attachments: [{ filename, content, bytes }] from mime.attachmentsOf.
// Returns what was written and, per file, why anything was refused. A file
// that is missing from the mail is simply not written - yesterday's copy stays.
export async function ingestObpCsv(hon, attachments, today) {
  const byName = new Map();
  for (const a of attachments || []) byName.set(String(a.filename || '').toLowerCase(), a);
  const out = { inventory: 0, intransit: 0, refused: [], seen: [...byName.keys()] };

  const inv = byName.get(CSV_FILES.inventory);
  const tr = byName.get(CSV_FILES.intransit);
  if (!inv && !tr) {
    out.refused.push(`neither ${CSV_FILES.inventory} nor ${CSV_FILES.intransit} attached`);
    return out;
  }
  await ensureTables(hon);

  if (inv) {
    const rows = mapInventory(parseCsv(textOf(inv)), today).map((r) => ({ ...r, source: 'csv' }));
    if (rows.length < MIN_INVENTORY_ROWS) {
      out.refused.push(`${CSV_FILES.inventory} parsed to ${rows.length} rows, below ${MIN_INVENTORY_ROWS} - not a fleet-wide export, not written`);
    } else {
      await replaceSnapshot(hon, CSV_INVENTORY, rows, today, INV_COLS);
      out.inventory = rows.length;
      out.inventory_ships = new Set(rows.map((r) => r.ship)).size;
      out.inventory_newest_update = rows.reduce((m, r) => (r.update_date && r.update_date > m ? r.update_date : m), '');
    }
  }
  if (tr) {
    const rows = mapIntransit(parseCsv(textOf(tr)), today).map((r) => ({ ...r, source: 'csv' }));
    const dated = rows.filter((r) => r.eta_date);
    if (!rows.length) {
      out.refused.push(`${CSV_FILES.intransit} parsed to 0 rows - not written`);
    } else if (dated.length < rows.length / 2) {
      out.refused.push(`${CSV_FILES.intransit}: only ${dated.length} of ${rows.length} rows carry a readable ShipProvDate - the export format may have changed, not written`);
    } else {
      await replaceSnapshot(hon, CSV_INTRANSIT, rows, today, TR_COLS);
      out.intransit = rows.length;
      out.intransit_undated = rows.length - dated.length;
    }
  }
  if (out.inventory || out.intransit) {
    try { out.filled = await fillFromMirror(hon, today); }
    catch (e) { out.refused.push(`mirror fill threw: ${String((e && e.message) || e)}`); }
  }
  return out;
}
