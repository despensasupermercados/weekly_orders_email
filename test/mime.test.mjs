// node test/mime.test.mjs
// Proves the email handler survives what Outlook actually sends. Before this
// existed, raw MIME went straight into the HTML parser: the green-PO row was
// lost entirely and the surviving row was written with null loading date,
// month and country. Base64 parsed zero rows and logged nothing.

import { htmlPartOf } from '../src/lib/mime.js';
import { rowsFromHtml, parseAzamaraRows } from '../src/lib/azamaraMls.js';
import assert from 'node:assert';

const table = `<table>
<tr><td>Ship</td><td>Delivery date to BWS</td><td>Port</td><td>Country</td><td>Ship Load Date</td><td></td><td>Month</td><td>PO Number</td></tr>
<tr><td>Journey</td><td>10/2/2026</td><td>New York</td><td>USA</td><td>10/7/2026</td><td></td><td>Oct</td><td></td></tr>
<tr><td>Pursuit</td><td>6/16/2026</td><td>Busan</td><td>South Korea</td><td>9/24/2026</td><td></td><td>Oct</td><td style="background:#C6EFCE">PRHOPO08668</td></tr>
</table>`;

// Encode the way Outlook does: = -> =3D, # -> =23, soft wraps every 70 chars.
const qp = table
  .replace(/=/g, '=3D')
  .replace(/#/g, '=23')
  .split('\n')
  .map((l) => (l.length > 70 ? `${l.slice(0, 70)}=\r\n${l.slice(70)}` : l))
  .join('\r\n');

const mime = (enc, payload) =>
  [
    'From: Ray Guerra <Ray.Guerra@dg3.com>',
    'Subject: Azamara MLS - September 2026',
    'Content-Type: multipart/alternative; boundary="_000_abc_"',
    '',
    '--_000_abc_',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello, please see updated MLS for your vessels',
    '',
    '--_000_abc_',
    'Content-Type: text/html; charset="utf-8"',
    `Content-Transfer-Encoding: ${enc}`,
    '',
    payload,
    '',
    '--_000_abc_--',
    '',
  ].join('\r\n');

const b64 = Buffer.from(table, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

for (const [name, raw] of [
  ['quoted-printable', mime('quoted-printable', qp)],
  ['base64', mime('base64', b64)],
]) {
  const html = htmlPartOf(raw);
  const rows = parseAzamaraRows(rowsFromHtml(html));
  assert.equal(rows.length, 2, `${name}: expected 2 rows, got ${rows.length}`);
  const p = rows.find((r) => r.ship === 'Pursuit');
  assert.ok(p, `${name}: Pursuit row lost`);
  assert.equal(p.po_state, 'confirmed', `${name}: green fill lost`);
  assert.equal(p.loading_delivery_date, '2026-09-24', `${name}: loading date lost`);
  assert.equal(p.month_label, 'Oct', `${name}: month lost`);
  assert.equal(p.dest_country, 'South Korea', `${name}: country lost`);
  assert.equal(rows.find((r) => r.ship === 'Journey').po_state, 'none', `${name}: blank PO misread`);
  console.log(`ok - ${name}: 2 rows, green preserved, dates and month intact`);
}

// The plain-text part must not be mistaken for the table.
assert.ok(/<table/i.test(htmlPartOf(mime('quoted-printable', qp))), 'picked the wrong MIME part');
console.log('ok - html part selected over text/plain');
