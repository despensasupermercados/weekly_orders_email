// node test/azamaraWorkbook.test.mjs
//
// Ray's Azamara MLS arrives either pasted into the body or as an .xlsx. On
// 11 Sep 2026 it arrived attached and the Worker refused it: "workbook parser
// is not wired". This pins the workbook path end to end: a real xlsx built with
// the bundled SheetJS, read back as bytes the way mime.attachmentsOf hands them
// over, through rowsFromWorkbook and parseAzamaraRows.

import assert from 'node:assert';
import * as XLSX from 'xlsx';
import { rowsFromWorkbook, parseAzamaraRows } from '../src/lib/azamaraMls.js';
import { attachmentsOf } from '../src/lib/mime.js';

const sheet = XLSX.utils.aoa_to_sheet([
  ['AZAMARA MASTER LOADING SCHEDULE'],
  [],
  ['SHIP', 'DELIVERY DATE TO BWS', 'PORT', 'COUNTRY', 'SHIP LOAD DATE', '', 'MONTH', 'PO NUMBER'],
  ['Quest', '12/8/2026', 'Miami', 'USA', '12/18/2026', '', 'December', 'PO-4411'],
  ['Onward', '10/6/2026', 'Auckland', 'New Zealand', '12/22/2026', '', 'December', ''],
  ['Journey', '', 'Rome', 'Italy', '', '', 'January', ''],   // placeholder, not scheduled
  ['Pursuit', '11/2/2026', 'Athens', 'Greece', '11/20/2026', '', 'November', 'PO-4412'],
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet, 'MLS');
const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

// Straight from bytes.
const rows = parseAzamaraRows(rowsFromWorkbook(XLSX.read, XLSX.utils, bytes));
assert.equal(rows.length, 3, 'three scheduled ships; the placeholder row is skipped');
const quest = rows.find((r) => r.ship === 'Quest');
assert.equal(quest.due_date, '2026-12-08');
assert.equal(quest.loading_delivery_date, '2026-12-18');
assert.equal(quest.po_number, 'PO-4411');
assert.equal(quest.po_state, 'raised');   // fills are not read by community SheetJS
assert.equal(rows.find((r) => r.ship === 'Onward').po_state, 'none');
assert.equal(rows.find((r) => r.ship === 'Onward').loading_port, 'Auckland', 'port/country swap is corrected');

// Through a MIME message, the way it really arrives: base64 attachment.
const b64 = Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\r\n');
const raw = [
  'From: ray@example.com', 'Subject: Azamara MLS', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B1"', '', '--B1',
  'Content-Type: text/html; charset=utf-8', '', '<p>Attached.</p>', '--B1',
  'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="Azamara MLS 2025.xlsx"',
  'Content-Disposition: attachment; filename="Azamara MLS 2025.xlsx"',
  'Content-Transfer-Encoding: base64', '', b64, '--B1--', '',
].join('\r\n');
const att = attachmentsOf(raw);
assert.equal(att.length, 1);
assert.ok(att[0].bytes instanceof Uint8Array && att[0].bytes.length === bytes.length, 'bytes survive the MIME decode intact');
const viaMime = parseAzamaraRows(rowsFromWorkbook(XLSX.read, XLSX.utils, att[0].bytes));
assert.equal(viaMime.length, 3);
assert.equal(viaMime.find((r) => r.ship === 'Pursuit').due_date, '2026-11-02');

console.log('ok - Azamara MLS workbook: an attached xlsx parses to dated rows through the MIME path');
