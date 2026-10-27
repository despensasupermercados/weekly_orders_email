// node test/mlsIngest.test.mjs
//
// RAY'S AZAMARA MLS WITH A BLANK SHIP LOAD DATE ON SOME ROWS. 27 Oct 2026,
// 11:13 UTC: "Azamara MLS 2025.xlsx" parsed 288 rows, 211 with a loading
// date, and the handler refused the whole file because one row short of all
// was not all. Nothing was written, Onward's schedule on file ran out on
// 3 Dec, and Ray - who had just been asked for the file - heard nothing.
// A blank load date on a loading not yet fixed is his sheet as he keeps it.
// Now: at least half usable, the usable rows are written and every skipped
// row is named; fewer than half is still a refusal (a lost column).
// Drives the real email() handler with a raw mail and a fake D1.

import assert from 'node:assert';
process.emitWarning = () => {};
const worker = (await import('../src/index.js')).default;

const B = '_000_mls_';
function rawMail(rows) {
  const tr = (r) => `<tr><td>${r.ship}</td><td>${r.bws}</td><td>Singapore</td><td>Singapore</td><td>${r.load}</td><td>Nov</td><td>${r.po}</td></tr>`;
  const html = `<html><body><p>Azamara MLS</p><table>
<tr><td>SHIP</td><td>DELIVERY DATE TO BWS</td><td>PORT</td><td>COUNTRY</td><td>SHIP LOAD DATE</td><td>MONTH</td><td>PO NUMBER</td></tr>
${rows.map(tr).join('\n')}
</table></body></html>`;
  return `From: Ray.Guerra@dg3.com\r\nSubject: Azamara MLS - November 2026\r\nContent-Type: multipart/alternative; boundary="${B}"\r\n\r\n` +
    `--${B}\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n${html}\r\n--${B}--\r\n`;
}
function message(raw) {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: 'Ray.Guerra@dg3.com',
    headers: new Map([['subject', 'Azamara MLS - November 2026']]),
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}
function fakeHon() {
  const written = []; const notes = []; const sql = [];
  const hon = {
    prepare(s) {
      const st = { args: [], bind(...a) { st.args = a; return st; },
        async run() { sql.push(s); if (/INSERT INTO ingest_log/.test(s)) notes.push(st.args[2]); return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; }, async first() { return null; } };
      return st;
    },
    async batch(stmts) { for (const st of stmts) written.push(st.args); },
  };
  return { hon, written, notes, sql };
}

// Four loadings, one without a Ship Load Date: three written, one named.
{
  const { hon, written, notes, sql } = fakeHon();
  await worker.email(message(rawMail([
    { ship: 'Journey', bws: '11/16/2026', load: '12/5/2026', po: 'PO1' },
    { ship: 'Onward', bws: '12/3/2026', load: '12/22/2026', po: '' },
    { ship: 'Onward', bws: '1/7/2027', load: '', po: '' },
    { ship: 'Quest', bws: '12/8/2026', load: '1/5/2027', po: 'PO3' },
  ])), { HON: hon });
  assert.equal(written.length, 3, `the three rows with a loading date are written: ${JSON.stringify(written)}`);
  assert.ok(written.every((a) => a[3]), 'none of them with a null loading date');
  assert.ok(sql.some((s) => /azamara-mls:prev/.test(s) && /UPDATE/.test(s)), 'the old set is parked first');
  assert.ok(sql.some((s) => /DELETE FROM schedule_order WHERE source = 'azamara-mls:prev'/.test(s)), 'and cleared after the write');
  const note = notes.find((n) => /^Azamara MLS \(from body\)/.test(n));
  assert.ok(note, `the ingest is logged: ${notes.join(' || ')}`);
  assert.match(note, /3 rows, 1 with no PO/);
  assert.match(note, /1 row\(s\) SKIPPED, no loading date: Onward due 2027-01-07/, note);
  assert.ok(!notes.some((n) => /REFUSED/.test(n)), 'not a refusal');
}

// Fewer than half with a loading date: the column is gone, refuse, write nothing.
{
  const { hon, written, notes } = fakeHon();
  await worker.email(message(rawMail([
    { ship: 'Journey', bws: '11/16/2026', load: '12/5/2026', po: 'PO1' },
    { ship: 'Onward', bws: '12/3/2026', load: '', po: '' },
    { ship: 'Onward', bws: '1/7/2027', load: '', po: '' },
    { ship: 'Quest', bws: '12/8/2026', load: '', po: 'PO3' },
  ])), { HON: hon });
  assert.equal(written.length, 0, 'nothing written');
  const note = notes.find((n) => /^Azamara MLS REFUSED/.test(n));
  assert.ok(note, `refused and said so: ${notes.join(' || ')}`);
  assert.match(note, /parsed 4 rows, 1 with a loading date \(need at least half\)/);
}

// Exactly half is enough: Ray's 27 Oct file was 211 of 288.
{
  const { hon, written, notes } = fakeHon();
  await worker.email(message(rawMail([
    { ship: 'Journey', bws: '11/16/2026', load: '12/5/2026', po: 'PO1' },
    { ship: 'Onward', bws: '12/3/2026', load: '', po: '' },
  ])), { HON: hon });
  assert.equal(written.length, 1);
  assert.ok(!notes.some((n) => /REFUSED/.test(n)));
}

console.log('ok - mls ingest: rows with a loading date are written and the rest named; fewer than half usable is still refused');
