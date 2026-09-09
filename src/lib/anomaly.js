// Inventory anomaly detection.
//
// THE CASE THIS EXISTS FOR. On Pursuit a single keystroke put a wrong figure
// into the count. Nothing in the system disagreed with it, so it stood for
// eight days and very nearly bought an air freight to Japan. No threshold
// anyone could set fleet-wide would have caught it: the number was not
// extreme, it was extreme FOR THAT SHIP. So every comparison here is against
// the ship's own trailing history and nothing else.
//
// ROBUSTNESS MATTERS MORE THAN SENSITIVITY. A mean and a standard deviation
// are both dragged by the very outlier they are meant to find, and a second
// bad reading hides the first. Median and median-absolute-deviation are not.
// The thresholds below are deliberately loose - this under-reports on purpose.
// An anomaly mail that cries wolf is filtered inside a month and then the real
// one is invisible too, which is how the night digest was designed as well.

import { require_, firstPresent } from './schema.js';

// 1.4826 * MAD estimates the standard deviation of a normal distribution. It is
// the standard robust-scale constant, not a tuned number.
const MAD_TO_SIGMA = 1.4826;

export const DEFAULTS = {
  min_history: 5,   // fewer points than this and there is no baseline worth the name
  sigma: 6,         // how many robust sigmas is "not this ship"
  digit_ratio: 8,   // a slipped digit multiplies by ~10; 8 catches it without catching a genuine restock
  floor: 2,         // absolute units below which nothing is worth waking anyone for
};

export const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function mad(xs) {
  const m = median(xs);
  if (m === null) return null;
  return median(xs.map((x) => Math.abs(x - m)));
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// How many consecutive most-recent snapshots carry this same value.
function runLength(pts, value) {
  let n = 0;
  for (let i = pts.length - 1; i >= 0 && pts[i].value === value; i--) n++;
  return { snapshots: n, first_seen: pts[pts.length - n].date };
}

// series: [{ date, value }] for ONE (ship, item), any order.
// Judges only the most recent point, and against the points BEFORE it, so the
// suspect reading never gets a vote on its own baseline.
export function judgeSeries(series, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const pts = series
    .filter((p) => p && p.date && Number.isFinite(Number(p.value)))
    .map((p) => ({ date: String(p.date), value: Number(p.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (pts.length < o.min_history + 1) {
    return { verdict: 'no_baseline', points: pts.length, needed: o.min_history + 1 };
  }

  const latest = pts[pts.length - 1];
  const history = pts.slice(0, -1).map((p) => p.value);
  const base = median(history);
  const scale = Math.max((mad(history) || 0) * MAD_TO_SIGMA, o.floor);
  const sigmas = Math.abs(latest.value - base) / scale;
  const ratio = base > 0 ? latest.value / base : null;

  // A count cannot be negative. This is not statistics, it is arithmetic, and
  // it needs no history at all to be certain about.
  if (latest.value < 0) {
    return {
      verdict: 'impossible',
      latest, base,
      detail: `negative value ${latest.value}`,
      since: runLength(pts, latest.value),
    };
  }

  const digitSlip = ratio !== null && (ratio >= o.digit_ratio || ratio <= 1 / o.digit_ratio);
  if (!digitSlip && sigmas < o.sigma) {
    return { verdict: 'normal', latest, base, sigmas: round(sigmas) };
  }

  return {
    verdict: digitSlip ? 'digit_slip' : 'outlier',
    latest,
    base,
    sigmas: round(sigmas),
    ratio: ratio === null ? null : round(ratio),
    // How long the bad figure has already been standing. This is the number
    // that mattered on Pursuit: not that it was wrong, but that it was wrong
    // for eight days and nothing said so.
    since: runLength(pts, latest.value),
    detail: digitSlip
      ? `${latest.value} against a trailing median of ${base} (x${round(ratio)}) - the shape of a mistyped digit`
      : `${latest.value} against a trailing median of ${base}, ${round(sigmas)} robust sigmas out`,
  };
}

// rows: [{ ship, item, date, value }] across the whole fleet.
export function findAnomalies(rows, opts = DEFAULTS) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.ship} ${r.item}`;
    if (!by.has(k)) by.set(k, { ship: r.ship, item: r.item, series: [] });
    by.get(k).series.push({ date: r.date, value: r.value });
  }

  const out = [];
  let judged = 0;
  let noBaseline = 0;
  for (const { ship, item, series } of by.values()) {
    const v = judgeSeries(series, opts);
    if (v.verdict === 'no_baseline') { noBaseline++; continue; }
    judged++;
    if (v.verdict === 'normal') continue;
    out.push({
      ship,
      item,
      severity: v.verdict === 'impossible' ? 'critical' : 'warn',
      code: v.verdict.toUpperCase(),
      detail: `${item}: ${v.detail}` +
        (v.since && v.since.snapshots > 1
          ? ` - unchanged for ${v.since.snapshots} snapshots, since ${v.since.first_seen}`
          : ''),
      value: v.latest.value,
      baseline: v.base,
      since: v.since,
    });
  }

  // Loudest first, and within that the ones that have been wrong longest.
  out.sort((a, b) =>
    a.severity === b.severity
      ? (b.since ? b.since.snapshots : 0) - (a.since ? a.since.snapshots : 0)
      : a.severity === 'critical' ? -1 : 1);

  return { findings: out, judged, no_baseline: noBaseline, series: by.size };
}

// ---- the database side ----
//
// consumption_snapshot belongs to cims-hon's ingest and its column names are
// not ours to assume. Resolve them and refuse to run rather than return an
// empty finding list, which would read as "the fleet is fine".

const ITEM_COLS = ['item', 'item_description', 'description', 'part', 'part_number', 'sku'];
const VALUE_COLS = ['on_hand', 'qty', 'quantity', 'consumed', 'usage', 'value', 'count'];
const DATE_COLS = ['snapshot_date', 'date', 'as_of', 'ts'];

// Fourteen snapshots is enough for a median to mean something and short enough
// that a genuine step change - a new machine, a route change - stops being
// reported after a fortnight instead of nagging forever.
export const WINDOW_SNAPSHOTS = 14;

export async function anomalyFindings(hon, opts = DEFAULTS) {
  const probe = await require_(hon, 'consumption_snapshot', ['ship']);
  if (!probe.ok) return { ran: false, reason: probe.reason, findings: [] };

  const itemCol = firstPresent(probe.columns, ITEM_COLS);
  const valueCol = firstPresent(probe.columns, VALUE_COLS);
  const dateCol = firstPresent(probe.columns, DATE_COLS);
  const missing = [
    !itemCol && `item (looked for ${ITEM_COLS.join(', ')})`,
    !valueCol && `value (looked for ${VALUE_COLS.join(', ')})`,
    !dateCol && `date (looked for ${DATE_COLS.join(', ')})`,
  ].filter(Boolean);
  if (missing.length) {
    return {
      ran: false,
      findings: [],
      reason: `consumption_snapshot has no recognisable ${missing.join(' and no ')}. ` +
        `Anomaly detection is UNKNOWN, not clean.`,
    };
  }

  const sql = `
    WITH recent AS (
      SELECT DISTINCT ${dateCol} AS d FROM consumption_snapshot
       ORDER BY d DESC LIMIT ${WINDOW_SNAPSHOTS}
    )
    SELECT ship,
           ${itemCol}  AS item,
           ${dateCol}  AS date,
           ${valueCol} AS value
      FROM consumption_snapshot
     WHERE ${dateCol} IN (SELECT d FROM recent)
       AND ${valueCol} IS NOT NULL`;

  const r = await hon.prepare(sql).all();
  const rows = r.results || [];
  // An empty read here is itself a finding. The feed check in the watchdog only
  // watches obp_*; consumption_snapshot could stop arriving unnoticed.
  if (!rows.length) {
    return { ran: false, findings: [], reason: 'consumption_snapshot returned no rows in the last ' + WINDOW_SNAPSHOTS + ' snapshots' };
  }
  const res = findAnomalies(rows, opts);
  return { ran: true, reason: null, columns: { itemCol, valueCol, dateCol }, ...res };
}
