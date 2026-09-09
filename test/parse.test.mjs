// node test/parse.test.mjs
// Runs the Azamara parser against a faithful reconstruction of the pasted table
// from Ray's "Azamara MLS - September 2026" email, colours included.

import { rowsFromHtml, parseAzamaraRows, isAzamaraMls } from '../src/lib/azamaraMls.js';
import assert from 'node:assert';

const G = 'style="background:#C6EFCE"';
const R = 'style="color:#FF0000"';
const BLACK = 'style="background:#000000"';

const html = `<table>
<tr><td>Ship</td><td>Delivery date to BWS</td><td>Port</td><td>Country</td><td>Ship Load Date</td><td></td><td>Month</td><td>PO Number</td></tr>
<tr><td>Journey</td><td>10/2/2026</td><td>New York</td><td>USA</td><td>10/7/2026</td><td></td><td>Oct</td><td></td></tr>
<tr><td>Journey</td><td>10/13/2026</td><td>New York</td><td>USA</td><td>10/29/2026</td><td></td><td>Nov</td><td></td></tr>
<tr><td>Journey</td><td>11/16/2026</td><td>San Juan</td><td>Puerto Rico</td><td>12/5/2026</td><td></td><td>Dec</td><td></td></tr>
<tr><td>Journey</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td ${BLACK}></td><td ${BLACK}></td><td ${BLACK}></td><td ${BLACK}></td><td ${BLACK}></td><td></td><td ${BLACK}></td><td ${BLACK}></td></tr>
<tr><td>Pursuit</td><td>6/16/2026</td><td>Busan</td><td>South Korea</td><td>9/24/2026</td><td></td><td>Oct</td><td ${G}>PRHOPO08668</td></tr>
<tr><td>Pursuit</td><td>7/20/2026</td><td>Hong Kong</td><td>China</td><td>10/30/2026</td><td></td><td>Nov</td><td ${G}>PRHOPO08922</td></tr>
<tr><td>Pursuit</td><td>8/31/2026</td><td>New Zealand</td><td>Auckland</td><td>12/19/2026</td><td></td><td>Dec</td><td ${G}>PRHOPO09052</td></tr>
<tr><td>Pursuit</td><td>9/25/2026</td><td>New Zealand</td><td>Auckland</td><td>1/20/2027</td><td></td><td>Jan</td><td>PRHOPO09175</td></tr>
<tr><td>Onward</td><td>7/24/2026</td><td>Venice</td><td>Italy</td><td>10/6/2026</td><td></td><td>Oct</td><td ${G}>ONHOPO08861</td></tr>
<tr><td>Onward</td><td ${R}>7/31/2026</td><td>Barcelona</td><td>Spain</td><td>11/7/2026</td><td></td><td>Nov</td><td ${G}>ONHOPO08904</td></tr>
<tr><td>Onward</td><td>10/6/2026</td><td>Rome (Civitavecchia)</td><td>Italy</td><td>12/22/2026</td><td></td><td>Dec</td><td></td></tr>
<tr><td>Quest</td><td>5/26/2026</td><td>Barcelona</td><td>Spain</td><td>9/6/2026</td><td></td><td>Sep</td><td ${G}>QSHOPO08557</td></tr>
<tr><td>Quest</td><td>7/3/2026</td><td>Athens</td><td>Greece</td><td>10/14/2026</td><td></td><td>Oct</td><td ${G}>QSHOPO08687</td></tr>
<tr><td>Quest</td><td>12/8/2026</td><td>Miami</td><td>USA</td><td>12/18/2026</td><td></td><td>Dec</td><td></td></tr>
<tr><td>Quest</td><td>12/18/2026</td><td>San Francisco</td><td>USA</td><td>1/5/2027</td><td></td><td>JAN</td><td></td></tr>
</table>`;

assert.equal(isAzamaraMls('', 'Azamara MLS - September 2026', ''), true, 'detects by subject');
assert.equal(isAzamaraMls('', 'Fw: something else', html), true, 'detects by body header');

const rows = parseAzamaraRows(rowsFromHtml(html));
assert.equal(rows.length, 14, `expected 14 data rows, got ${rows.length}`);

const byShip = (s) => rows.filter((r) => r.ship === s);
assert.equal(byShip('Journey').length, 3);
assert.ok(byShip('Journey').every((r) => r.po_state === 'none'), 'Journey has no POs at all');

const jan = byShip('Pursuit').find((r) => r.month_label === 'Jan');
assert.equal(jan.po_state, 'raised', 'PO present but not green = raised, not confirmed');
assert.equal(byShip('Pursuit').filter((r) => r.po_state === 'confirmed').length, 3);

const dec = byShip('Pursuit').find((r) => r.month_label === 'Dec');
assert.equal(dec.loading_port, 'Auckland', 'swapped Port/Country is corrected');
assert.equal(dec.dest_country, 'New Zealand');

const nov = byShip('Onward').find((r) => r.month_label === 'Nov');
assert.equal(nov.date_changed, 1, 'red date is flagged as moved');

assert.equal(rows.filter((r) => r.po_state === 'none').length, 6, 'six voyages with no order raised');
assert.equal(rows.find((r) => r.ship === 'Journey').due_date, '2026-10-02', 'US date order');

console.log(`ok - ${rows.length} rows, ${rows.filter((r) => r.po_state === 'none').length} with no PO`);
