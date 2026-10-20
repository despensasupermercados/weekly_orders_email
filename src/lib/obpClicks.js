// THE CLICKS FILE, READ (20 Oct 2026).
//
// Jerwin's daily clicks.csv reached obp-csv@cims.work for the first time on
// 19 Oct 2026, 12:27 UTC: 44,559 lines, 2.48 MB, every machine every day from
// 1 Jan 2026. Its columns, as delivered:
//   ShipID,EquipmentID,ClicksDate,Color,Mono,TotalColor,TotalMono,is_mfd
//   14,336,2026-01-02 00:00:00.000,2000,900,2858253,920088,0
// Color / Mono are THAT DAY's clicks: they equal the day's change in the meter
// totals (Navigator press 336: 2,858,253 - 2,856,253 = 2,000 on 2 Jan, and
// 0 / 0 on 1 Feb when the meter did not move). is_mfd 0 is a production press,
// 1 an office MFD. The HR console's Score Card reads the PRESS rows (mono
// share of press clicks over a contract, Miguel 15 Oct 2026).
//
// keepClicks kept the file as one text row cut at 1.5 MB, so the first file
// stopped at 24 Jun and every later day would have been lost the same way.
// This reads the WHOLE attachment on arrival, one row per machine per day, in
// weekly_obp_clicks (this Worker's own table, like the other weekly_obp_*).
// Every column is kept, MFDs included; readers filter.
//
// The file restates the year each day. The first load writes every row; after
// that only the last RESTATE_DAYS before the newest day already held are
// rewritten (a reading entered late changes the days it covers), so a day costs
// ~5k row writes instead of 45k. A ShipID OBP's ship list does not hold is kept
// with ship NULL and named in the log line, never guessed (see obpShips.js).

import { parseCsv, usDate, num, textOf, isClicksFile, keepClicks, CLICKS_RAW, CLICKS_RAW_DDL, MAX_BLANK_SHARE } from './obpCsv.js';
import { obpShipName } from './obpShips.js';

export const CLICKS = 'weekly_obp_clicks';
export const CLICK_HEADERS = ['ShipID', 'EquipmentID', 'ClicksDate', 'Color', 'Mono', 'is_mfd'];
export const MIN_CLICK_ROWS = 100;
export const RESTATE_DAYS = 31;

export const CLICKS_DDL = [
  `CREATE TABLE IF NOT EXISTS ${CLICKS} (
     equipment_id INTEGER NOT NULL, day TEXT NOT NULL,
     ship_id INTEGER NOT NULL, ship TEXT, is_mfd INTEGER,
     color INTEGER, mono INTEGER, total_color INTEGER, total_mono INTEGER,
     received_at TEXT NOT NULL,
     PRIMARY KEY (equipment_id, day))`,
  `CREATE INDEX IF NOT EXISTS ${CLICKS}_ship_day ON ${CLICKS} (ship, day)`,
  CLICKS_RAW_DDL, // the receipt
];

const int = (v) => {
  const n = num(v);
  return n == null || !Number.isInteger(n) ? null : n;
};
// "0" / "1", or the True / False a SQL export sometimes writes. Anything else is unread.
const flag = (v) => {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (t === '1' || t === 'true') return 1;
  if (t === '0' || t === 'false') return 0;
  return null;
};

// A ShipName column, if the export ever carries one, is OBP's own word and wins over the map.
export function mapClicks(rows) {
  return (rows || [])
    .map((r) => {
      const shipId = int(r.ShipID);
      return {
        ship_id: shipId,
        ship: (r.ShipName && String(r.ShipName).trim()) || obpShipName(shipId),
        equipment_id: int(r.EquipmentID),
        day: usDate(r.ClicksDate),
        color: int(r.Color),
        mono: int(r.Mono),
        total_color: int(r.TotalColor),
        total_mono: int(r.TotalMono),
        is_mfd: flag(r.is_mfd),
      };
    })
    .filter((r) => r.ship_id != null && r.equipment_id != null && r.day);
}

const COLS = ['equipment_id', 'day', 'ship_id', 'ship', 'is_mfd', 'color', 'mono', 'total_color', 'total_mono', 'received_at'];

function addDays(iso, n) {
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) ? iso : new Date(t + n * 86400000).toISOString().slice(0, 10);
}

async function runAll(hon, stmts) {
  if (typeof hon.batch === 'function') {
    for (let i = 0; i < stmts.length; i += 50) await hon.batch(stmts.slice(i, i + 50));
  } else {
    for (const s of stmts) await s.run();
  }
}

// One file: refuse by name (and keep the raw text, so a changed format can be read), or write it.
async function ingestOne(hon, file, receivedAt) {
  const text = textOf(file);
  const raw = parseCsv(text);
  const have = new Set(raw.length ? Object.keys(raw[0]) : []);
  const miss = CLICK_HEADERS.filter((h) => !have.has(h));
  const rows = mapClicks(raw);
  const out = { filename: String(file.filename), lines: raw.length, rows: rows.length };
  let refused = null;
  if (miss.length) refused = `column(s) ${miss.join(', ')} not in the header - the export format changed`;
  else if (rows.length < MIN_CLICK_ROWS) refused = `${rows.length} readable rows, below ${MIN_CLICK_ROWS}`;
  else if (rows.filter((r) => r.color == null || r.mono == null).length > rows.length * MAX_BLANK_SHARE) refused = 'Color / Mono unreadable on too many rows';
  else if (rows.filter((r) => r.is_mfd == null).length > rows.length * MAX_BLANK_SHARE) refused = 'is_mfd unreadable on too many rows';
  if (refused) {
    await keepClicks(hon, [file], receivedAt);
    return { ...out, refused };
  }

  // the last row for a key wins (the file is in day order; a repeated key is a restated reading)
  const byKey = new Map();
  for (const r of rows) byKey.set(r.equipment_id + '|' + r.day, { ...r, received_at: receivedAt });
  const all = [...byKey.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.equipment_id - b.equipment_id));
  const last = await hon.prepare(`SELECT MAX(day) d FROM ${CLICKS}`).first();
  const since = last && last.d ? addDays(last.d, -RESTATE_DAYS) : null;
  const write = since ? all.filter((r) => r.day >= since) : all;

  // D1 binds at most 100 parameters per statement: ten columns, ten rows a statement.
  const per = Math.floor(100 / COLS.length);
  const set = COLS.filter((c) => c !== 'equipment_id' && c !== 'day').map((c) => `${c}=excluded.${c}`).join(', ');
  const stmts = [];
  for (let i = 0; i < write.length; i += per) {
    const chunk = write.slice(i, i + per);
    const ph = chunk.map(() => `(${COLS.map(() => '?').join(',')})`).join(',');
    stmts.push(hon.prepare(`INSERT INTO ${CLICKS} (${COLS.join(',')}) VALUES ${ph} ON CONFLICT(equipment_id, day) DO UPDATE SET ${set}`)
      .bind(...chunk.flatMap((r) => COLS.map((c) => r[c] ?? null))));
  }
  await runAll(hon, stmts);
  // Proof the write landed: every row written carries this arrival's stamp.
  const got = await hon.prepare(`SELECT COUNT(*) n FROM ${CLICKS} WHERE received_at = ?`).bind(receivedAt).first();
  const wrote = Number(got && got.n);

  // The receipt, without a second copy of the text: the rows are the file.
  const header = (String(text).split(/\r?\n/, 1)[0] || '').slice(0, 1000);
  await hon.prepare(`INSERT INTO ${CLICKS_RAW} (received_at, filename, chars, truncated, header, line_count, text) VALUES (?,?,?,0,?,?,'')`)
    .bind(receivedAt, String(file.filename), String(text).length, header, raw.length).run();

  const unplaced = [...new Set(all.filter((r) => !r.ship).map((r) => r.ship_id))].sort((a, b) => a - b);
  return {
    ...out, first: all[0].day, newest: all[all.length - 1].day, wrote, expected: write.length,
    load: since ? `from ${since}` : 'first load', unplaced,
  };
}

// attachments: [{ filename, content, bytes }]. Returns one line per clicks file.
export async function ingestClicks(hon, attachments, receivedAt) {
  const files = (attachments || []).filter((a) => isClicksFile(a.filename));
  if (!files.length) return { files: [] };
  for (const sql of CLICKS_DDL) await hon.prepare(sql).run();
  const res = [];
  for (const f of files) {
    try { res.push(await ingestOne(hon, f, receivedAt)); }
    catch (e) { res.push({ filename: String(f.filename), error: String((e && e.message) || e).slice(0, 160) }); }
  }
  return { files: res };
}

// The ingest_log wording, built in one place.
export function clicksNote(r) {
  if (!r || !r.files || !r.files.length) return '';
  return ' | clicks: ' + r.files.map((f) => {
    if (f.error) return `${f.filename} NOT READ: ${f.error}`;
    if (f.refused) return `${f.filename} REFUSED (${f.refused}), kept raw`;
    const short = f.wrote !== f.expected ? ` (SHORT: ${f.wrote} of ${f.expected})` : '';
    return `${f.filename} ${f.rows} rows ${f.first}..${f.newest}, ${f.wrote} written, ${f.load}${short}` +
      (f.unplaced.length ? `; OBP ShipID not on the ship list: ${f.unplaced.join(', ')}` : '');
  }).join('; ');
}
