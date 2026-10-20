// node test/obpClicks.test.mjs
//
// The clicks file, read (20 Oct 2026). Pins: the delivered file's own columns
// and semantics (Color / Mono are the day's clicks, the meter totals move by
// exactly that), OBP's ShipID -> name map, a file longer than the old 1.5 MB
// keep is read WHOLE, the daily restatement rewrites only the recent days, a
// changed format is refused by name and kept raw, and the log line.

process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const assert = (await import('node:assert')).default;
const { parseCsv, isObpCsvMail, CLICKS_RAW, CLICKS_MAX_CHARS } = await import('../src/lib/obpCsv.js');
const { mapClicks, ingestClicks, clicksNote, CLICKS, RESTATE_DAYS, MIN_CLICK_ROWS } = await import('../src/lib/obpClicks.js');
const { OBP_SHIPS, obpShipName } = await import('../src/lib/obpShips.js');

function d1(db) {
  const make = (sql, binds) => ({
    bind(...args) { return make(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { return db.prepare(sql).run(...binds); },
  });
  return { prepare(sql) { return make(sql, []); }, async batch(stmts) { for (const s of stmts) await s.run(); return []; } };
}

// ---- the delivered file's own lines (clicks.csv of 19 Oct 2026, as stored in weekly_obp_clicks_raw) ----
const HEAD = 'ShipID,EquipmentID,ClicksDate,Color,Mono,TotalColor,TotalMono,is_mfd';
const REAL = [
  '14,336,2026-01-01 00:00:00.000,1043,1104,2856253,919188,0',
  '14,336,2026-01-02 00:00:00.000,2000,900,2858253,920088,0',
  '14,336,2026-01-03 00:00:00.000,3745,1327,2861998,921415,0',
  '14,336,2026-01-31 00:00:00.000,5128,1914,2971335,954494,0',
  '14,336,2026-02-01 00:00:00.000,0,0,2971335,954494,0',
  '14,336,2026-02-02 00:00:00.000,7970,2208,2979305,956702,0',
  '1,96,2026-01-01 00:00:00.000,222,311,200529,345667,1',
  '1,234,2026-01-01 00:00:00.000,4502,2506,5225707,957189,0',
];
const real = mapClicks(parseCsv([HEAD, ...REAL].join('\r\n') + '\r\n'));
assert.equal(real.length, REAL.length);
assert.deepEqual(real[1], { ship_id: 14, ship: 'Navigator', equipment_id: 336, day: '2026-01-02', color: 2000, mono: 900, total_color: 2858253, total_mono: 920088, is_mfd: 0 });
// Color / Mono are the day's clicks: the meter totals move by exactly that, and a quiet day reads 0 / 0.
for (const [a, b] of [[0, 1], [1, 2], [3, 4], [4, 5]]) {
  assert.equal(real[b].total_color - real[a].total_color, real[b].color, 'color = the day\'s meter change');
  assert.equal(real[b].total_mono - real[a].total_mono, real[b].mono, 'mono = the day\'s meter change');
}
assert.equal(real[6].is_mfd, 1, 'an office MFD');
assert.equal(real[7].ship, null, 'ShipID 1 is not on OBP\'s Royal + Celebrity list: no name, never a guess');
assert.equal(obpShipName(84), 'Xcel');
assert.equal(obpShipName(47), null, 'a deleted OBP row (Wonder RCG) is not a ship');
assert.equal(Object.keys(OBP_SHIPS).length, 44, '30 Royal + 14 Celebrity hulls');
assert.equal(mapClicks(parseCsv('ShipName,' + HEAD + '\nNavigator of the Seas,14,336,2026-01-02,1,2,3,4,0\n'))[0].ship, 'Navigator of the Seas', 'a ShipName column is OBP\'s word and wins');
assert.equal(mapClicks(parseCsv(HEAD + '\n14,336,2026-01-02,,,,,True\n'))[0].color, null, 'a blank is an absence, never 0');
assert.ok(isObpCsvMail('clicks.csv', ''), 'the delivered name is the OBP CSV route');
console.log('ok - obp clicks: the delivered columns, the day\'s clicks, OBP\'s ship numbers');

// ---- a whole file, longer than the old 1.5 MB keep ----
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const machines = [[14, 334, 0], [14, 336, 0], [1, 96, 1], [1, 234, 0], [64, 325, 0], [64, 379, 0], [50, 132, 1], [84, 390, 0], [84, 411, 0], [8, 295, 0]];
function file(days, bump = 0) {
  const lines = [HEAD];
  for (let i = 0; i < days; i++) {
    for (const [s, e, m] of machines) {
      lines.push(`${s},${e},${day(i)} 00:00:00.000,${1000 + i + bump},${100 + (i % 7)},${2000000 + i * 1000},${900000 + i * 100},${m}`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}
// 2,900 rows of the delivered width is ~165 kB: repeat them past the old 1.5 MB ceiling (the real file is 2.48 MB)
const days = 290;
let big = file(days);
while (big.length <= CLICKS_MAX_CHARS) big += big.split('\r\n').slice(1).join('\r\n');
assert.ok(big.length > CLICKS_MAX_CHARS, 'the fixture is longer than the old keep');
const db = new DatabaseSync(':memory:');
const hon = d1(db);
const r1 = await ingestClicks(hon, [{ filename: 'clicks.csv', content: big }, { filename: 'onboardinventory.csv', content: 'x' }], '2026-10-19T12:27:42.472Z');
assert.equal(r1.files.length, 1, 'only the clicks file');
const f1 = r1.files[0];
assert.equal(f1.load, 'first load');
assert.equal(f1.newest, day(days - 1), 'the newest day is read, past where the old keep cut the file');
assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${CLICKS}`).get().n, days * machines.length, 'one row per machine per day, repeats folded');
assert.equal(f1.wrote, f1.expected);
assert.deepEqual(f1.unplaced, [1, 50]);
const rcpt = db.prepare(`SELECT filename, chars, truncated, text, header FROM ${CLICKS_RAW}`).get();
assert.equal(rcpt.text, '', 'the receipt carries no second copy of the text: the rows are the file');
assert.equal(rcpt.truncated, 0);
assert.equal(rcpt.header, HEAD);
assert.equal(rcpt.chars, big.length);
const nav = db.prepare(`SELECT SUM(color) c, SUM(mono) m FROM ${CLICKS} WHERE ship='Navigator' AND is_mfd=0 AND day >= ? AND day <= ?`).get(day(10), day(19));
assert.equal(nav.c, 2 * [...Array(10)].reduce((a, _, k) => a + 1000 + 10 + k, 0), 'press clicks sum by ship and day');
console.log('ok - obp clicks: a file past the old 1.5 MB keep is read whole into weekly_obp_clicks');

// ---- the next day restates only the recent days ----
const r2 = await ingestClicks(hon, [{ filename: 'clicks.csv', content: file(days + 1, 5) }], '2026-10-20T12:27:00.000Z');
const f2 = r2.files[0];
assert.equal(f2.load, 'from ' + day(days - 1 - RESTATE_DAYS));
assert.equal(f2.expected, (RESTATE_DAYS + 2) * machines.length, 'the last 31 days before the newest held, and the new day');
assert.equal(f2.wrote, f2.expected);
assert.equal(db.prepare(`SELECT color FROM ${CLICKS} WHERE equipment_id=336 AND day=?`).get(day(days - 1)).color, 1000 + days - 1 + 5, 'a restated day takes the new reading');
assert.equal(db.prepare(`SELECT color, received_at FROM ${CLICKS} WHERE equipment_id=336 AND day=?`).get(day(0)).received_at, '2026-10-19T12:27:42.472Z', 'an old day is not rewritten');
assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${CLICKS}`).get().n, (days + 1) * machines.length);
console.log('ok - obp clicks: the daily file rewrites only the last 31 days');

// ---- a changed format is refused by name and kept raw ----
const renamed = file(20).replace('is_mfd', 'IsMFD');
const r3 = await ingestClicks(hon, [{ filename: 'clicks.csv', content: renamed }], '2026-10-21T12:27:00.000Z');
assert.match(r3.files[0].refused, /is_mfd not in the header/);
assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${CLICKS} WHERE received_at='2026-10-21T12:27:00.000Z'`).get().n, 0, 'nothing written');
assert.equal(db.prepare(`SELECT text FROM ${CLICKS_RAW} WHERE received_at='2026-10-21T12:27:00.000Z'`).get().text, renamed, 'kept raw so the new format can be read');
const r4 = await ingestClicks(hon, [{ filename: 'clicks.csv', content: [HEAD, ...REAL].join('\n') }], '2026-10-22T00:00:00Z');
assert.match(r4.files[0].refused, new RegExp(`below ${MIN_CLICK_ROWS}`), 'a short file is refused');
console.log('ok - obp clicks: a renamed column or a short file is refused and kept raw');

// ---- the log line ----
assert.equal(clicksNote({ files: [] }), '');
assert.match(clicksNote(r1), /^ \| clicks: clicks\.csv \d+ rows 2026-01-01\.\.2026-10-17, 2900 written, first load; OBP ShipID not on the ship list: 1, 50$/);
assert.match(clicksNote(r3), /REFUSED \(column\(s\) is_mfd not in the header - the export format changed\), kept raw/);
assert.match(clicksNote({ files: [{ filename: 'clicks.csv', rows: 9, first: 'a', newest: 'b', wrote: 3, expected: 9, load: 'first load', unplaced: [] }] }), /SHORT: 3 of 9/);
console.log('ok - obp clicks: the log line names rows, days, writes and the ShipIDs not placed');
