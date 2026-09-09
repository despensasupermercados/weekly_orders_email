// Parses Ray's monthly "Azamara MLS - <Month> <Year>" email.
//
// Handles BOTH an .xlsx/.xls attachment AND a table pasted into the HTML body,
// because Ray does the latter and the existing cims-hon ingest returns before it
// ever looks at the body.
//
// Colour carries meaning and must survive parsing:
//   green-filled PO cell  -> po_state 'confirmed'
//   PO present, no fill   -> po_state 'raised'
//   PO blank, Month set   -> po_state 'none'   <-- the miss signal
//   red font on a date    -> date_changed = 1  (moved since last publication)

export const AZ_SHIPS = ['Journey', 'Onward', 'Pursuit', 'Quest'];

const GREEN = /green|c6efce|a9d08e|92d050|00b050|b6d7a8|d9ead3/i;
const RED_FONT = /color:\s*(red|#(ff0000|c00000|e00000|cc0000))/i;

const norm = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export function isAzamaraMls(filename, subject, bodyText) {
  const hay = `${filename || ''} ${subject || ''}`.toUpperCase();
  if (/AZAMARA\s+MLS/.test(hay)) return true;
  // Fallback: the body carries the distinctive header even if the subject changed.
  return /DELIVERY\s*DATE\s*TO\s*BWS/i.test(bodyText || '');
}

export function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = norm(v);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // 10/2/2026 (US order)
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s); // Excel serial
  if (isFinite(n) && n > 20000 && n < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ---------- HTML body path ----------
export function rowsFromHtml(html) {
  const out = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
  let tr;
  while ((tr = rowRe.exec(html))) {
    const cells = [];
    let td;
    cellRe.lastIndex = 0;
    while ((td = cellRe.exec(tr[0]))) {
      const attrs = td[1] || '';
      const inner = td[2] || '';
      const text = norm(
        inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      );
      const bg = (attrs.match(/background(?:-color)?:\s*([^;"']+)/i) || [])[1] || '';
      cells.push({ text, green: GREEN.test(bg), red: RED_FONT.test(attrs) || RED_FONT.test(inner) });
    }
    if (cells.length) out.push(cells);
  }
  return out;
}

// ---------- workbook path (xlsx must be read with cellStyles: true) ----------
export function rowsFromWorkbook(readSync, utils, buf) {
  const wb = readSync(buf, { type: 'buffer', cellStyles: true, cellDates: true });
  const out = [];
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    if (!sh['!ref']) continue;
    const r = utils.decode_range(sh['!ref']);
    for (let R = r.s.r; R <= r.e.r; R++) {
      const cells = [];
      for (let C = r.s.c; C <= r.e.c; C++) {
        const c = sh[utils.encode_cell({ r: R, c: C })];
        const fill = c && c.s && c.s.fgColor && c.s.fgColor.rgb ? String(c.s.fgColor.rgb) : '';
        const font = c && c.s && c.s.color && c.s.color.rgb ? String(c.s.color.rgb) : '';
        cells.push({
          text: c ? norm(c.w != null ? c.w : c.v) : '',
          green: GREEN.test(fill),
          red: /^ff(0000|c000|e000)/i.test(font) || /^(ff0000|c00000)/i.test(font),
        });
      }
      out.push(cells);
    }
  }
  return out;
}

// ---------- shared row interpreter ----------
// Columns are located by header text, so the blank spacer columns between the
// left block (Ship..Ship Load Date) and the right block (Month, PO Number) do
// not matter, and neither does Ray moving them.
const HEADERS = {
  ship: /^SHIP$/i,
  bws: /DELIVERY\s*DATE\s*TO\s*BWS/i,
  port: /^PORT$/i,
  ctry: /^COUNTRY$/i,
  load: /SHIP\s*LOAD\s*DATE/i,
  month: /^MONTH$/i,
  po: /^PO\s*NUMBER$/i,
};

const COUNTRYISH = /^(usa|united states|puerto rico|italy|spain|greece|china|south korea|new zealand|iceland|france|canada|japan)$/i;

export function parseAzamaraRows(rows) {
  let idx = null;
  const out = [];
  for (const cells of rows) {
    const texts = cells.map((c) => c.text);

    if (!idx) {
      const found = {};
      texts.forEach((t, i) => {
        for (const [k, re] of Object.entries(HEADERS)) if (found[k] == null && re.test(t)) found[k] = i;
      });
      // The BWS column is the fingerprint of this file. Nothing else has it.
      if (found.bws != null && found.ship != null) idx = found;
      continue;
    }

    const at = (k) => (idx[k] == null ? null : cells[idx[k]]);
    const shipCell = at('ship');
    const ship = norm(shipCell && shipCell.text);
    // Skips the solid black separator rows and the trailing blank placeholder rows.
    if (!AZ_SHIPS.some((s) => s.toLowerCase() === ship.toLowerCase())) continue;

    const bws = at('bws');
    const dueDate = toIso(bws && bws.text);
    if (!dueDate) continue; // placeholder row for a loading not yet scheduled

    const load = at('load');
    const po = at('po');
    const monthCell = at('month');
    const portCell = at('port');
    const ctryCell = at('ctry');
    let port = norm(portCell && portCell.text);
    let country = norm(ctryCell && ctryCell.text);
    // Ray swaps these on some rows (Port "New Zealand", Country "Auckland").
    if (COUNTRYISH.test(port) && !COUNTRYISH.test(country)) {
      const t = port; port = country; country = t;
    }

    const poNum = norm(po && po.text);
    out.push({
      ship,
      po_number: poNum || null,
      po_state: !poNum ? 'none' : (po && po.green ? 'confirmed' : 'raised'),
      due_date: dueDate,
      loading_delivery_date: toIso(load && load.text),
      loading_port: port || null,
      dest_country: country || null,
      month_label: norm(monthCell && monthCell.text) || null,
      date_changed: ((bws && bws.red) || (load && load.red)) ? 1 : 0,
    });
  }
  return out;
}

// Ray writes per-ship deadlines in the covering prose that appear nowhere in the
// table: "PR - make final updates if needed for your order due 9/25/2026".
export function notesFromBody(text) {
  const out = [];
  const re = /\b(JR|ON|PR|QS)\b[^.\n]{0,120}/gi;
  let m;
  while ((m = re.exec(text || ''))) {
    const line = norm(m[0]);
    if (/due|order|adjust|review|update/i.test(line)) out.push(line);
  }
  return out.slice(0, 20);
}

export async function saveAzamara(db, rows, source) {
  if (!rows.length) return { written: 0, missing: 0 };
  // Park the previous publication rather than deleting it, so a moved due date
  // stays comparable until the new set is safely in.
  await db.prepare(
    "UPDATE schedule_order SET source = 'azamara-mls:prev' WHERE source = 'azamara-mls'"
  ).run();

  const stmt = db.prepare(
    `INSERT INTO schedule_order
       (ship, voyage, mot, cadence, loading_port, loading_delivery_date,
        total_lead_days, due_date, must_be_in_ct_by, status, source,
        po_number, po_state, date_changed)
     VALUES (?, ?, 'AZAMARA BWS', 'monthly', ?, ?, ?, ?, date(?, '-3 day'), ?, ?, ?, ?, ?)`
  );

  const today = new Date().toISOString().slice(0, 10);
  const batch = rows.map((r) => {
    const lead = r.loading_delivery_date
      ? Math.round((Date.parse(r.loading_delivery_date) - Date.parse(r.due_date)) / 86400000)
      : null;
    const status = r.due_date < today ? 'past_ct' : 'on_track';
    return stmt.bind(
      r.ship, r.po_number, r.loading_port, r.loading_delivery_date,
      lead, r.due_date, r.due_date, status, source,
      r.po_number, r.po_state, r.date_changed
    );
  });
  for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));

  await db.prepare("DELETE FROM schedule_order WHERE source = 'azamara-mls:prev'").run();
  return { written: rows.length, missing: rows.filter((r) => r.po_state === 'none').length };
}
