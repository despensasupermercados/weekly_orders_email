// node test/mime.test.mjs
// Proves the email handler survives what Outlook actually sends. Before this
// existed, raw MIME went straight into the HTML parser: the green-PO row was
// lost entirely and the surviving row was written with null loading date,
// month and country. Base64 parsed zero rows and logged nothing.

import { htmlPartOf, attachmentsOf } from '../src/lib/mime.js';
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

// ---------------------------------------------------------------------------
// THE CLOSING DELIMITER NEED NOT END WITH A NEWLINE.
//
// Found 22 Sep 2026. RFC 2046 lets the final `--boundary--` be the last thing
// in the message, and real senders do that. The split required a newline AFTER
// the delimiter, so the closing marker never split and stayed glued to the last
// part's body. It did NOT throw — base64Bytes strips non-base64 characters, so
// `--X_BOUND_1--` became `XBOUND1`, was appended to the payload and decoded
// into four junk bytes and an `=` on the end of the file. A corrupt final row
// in an Ordering Schedule, or a corrupt zip inside an .xlsx, out of a message
// that is perfectly legal, with nothing anywhere saying so.
//
// Both htmlPartOf and attachmentsOf carried their own copy of the line and so
// their own copy of the bug; they share mimeParts now.
{
  const B = 'X_BOUND_1';
  const payload = 'ship,qty\nAllure,4\n';
  const b64 = Buffer.from(payload).toString('base64');
  const msg = (tail) =>
    `Content-Type: multipart/mixed; boundary="${B}"\r\n\r\n` +
    `--${B}\r\nContent-Type: text/html\r\n\r\n<table><tr><td>MLS</td></tr></table>\r\n` +
    `--${B}\r\nContent-Type: application/octet-stream\r\n` +
    `Content-Disposition: attachment; filename="sched.csv"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--${B}--${tail}`;

  for (const [label, tail] of [
    ['closing CRLF', '\r\n'],
    ['NO closing newline', ''],      // the bug
    ['LF only', '\n'],
    ['with an epilogue', '\r\nthanks\r\n'],
  ]) {
    const att = attachmentsOf(msg(tail));
    assert.equal(att.length, 1, `${label}: one attachment`);
    assert.equal(att[0].filename, 'sched.csv', `${label}: filename`);
    assert.equal(Buffer.from(att[0].content).toString('utf8'), payload,
      `${label}: the attachment must decode byte for byte, not with the boundary glued on`);

    const html = htmlPartOf(msg(tail));
    assert.ok(html.includes('</table>'), `${label}: the html part survives`);
    assert.ok(!html.includes(B), `${label}: the boundary must not leak into the html body`);
  }
}

console.log('ok - mime: a closing boundary with no trailing newline no longer corrupts the attachment or the html part');
