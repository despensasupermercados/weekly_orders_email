// A MONTH THAT LOOKS MISTYPED IS LEFT OUT OF THE 3-MONTH AVERAGE.
//
// Miguel, 17 Nov 2026: plan on "the higher of last month and the 3-month
// average" (Ray, same day: "review consumption vs last 3 months"), and leave a
// month flagged as a spike out of that average. Under "the higher of", a
// mistyped month inside the three becomes the plan: Pursuit's August 8.5x11,
// 30 entered for one box, would have lifted it from 15 to 22.5.
//
// TWIN OF cims-hon src/lib/consumption.js usageAnomaly() + usedInMonth().
// The flag must be the one HON's record prints, or the crew's handover and
// Monday's email disagree on which month is suspect. Change one, change both;
// test/spike.test.mjs pins the cases HON's own tests pin.

export const SPIKE_MULTIPLE = 2;   // Ray's "double"
export const SPIKE_FLOOR = 6;      // below this, doubling is noise on a slow item
export const WINDOW = 6;           // the months the flag is judged over

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// series: [{ month, used }] oldest first. The SPIKE half of HON's usageAnomaly:
// the biggest month against the median of the rest. Fewer than five measured
// months is too little history to judge.
export function spikeOf(series) {
  const rows = (series || []).filter((r) => r && r.month && r.used != null);
  if (rows.length < 5) return null;
  let hi = rows[0];
  for (const r of rows) if (r.used > hi.used) hi = r;
  const typical = median(rows.filter((r) => r !== hi).map((r) => r.used));
  if (hi.used >= SPIKE_FLOOR && typical != null && typical > 0 && hi.used >= typical * SPIKE_MULTIPLE) {
    return { month: hi.month, used: hi.used, typical: Math.round(typical) };
  }
  return null;
}

const idx = (ym) => { const [y, m] = String(ym).split('-').map(Number); return y * 12 + (m - 1); };
const ymOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

// rows: consumption_snapshot rows for ONE ship/part ({ month, on_hand,
// receipts, source, opening, xq }), xq = units sent to other ships that month.
// Returns { 'YYYY-MM': used } as HON's usedInMonth computes it: an export month
// carries its own opening count; any other month needs the calendar month
// before it; a negative figure is unmeasured, never zero.
export function usedByMonth(rows) {
  const by = new Map((rows || []).map((r) => [r.month, r]));
  const out = {};
  for (const cur of by.values()) {
    let open = null;
    if (cur.source === 'csv' && cur.opening != null) open = Number(cur.opening);
    else {
      const prev = by.get(ymOf(idx(cur.month) - 1));
      if (prev && prev.on_hand != null) open = Number(prev.on_hand);
    }
    if (open == null || cur.on_hand == null) continue;
    const u = open + Number(cur.receipts || 0) - Number(cur.on_hand) - Number(cur.xq || 0);
    if (u >= 0) out[cur.month] = Math.round(u);
  }
  return out;
}

// The month to leave out of the 3-month average, or null. `month` is the run
// month; last month is never skipped (it is Ray's figure, the ship corrects it
// in OBP), and only a month inside the three can be.
export function skippedMonth(rows, month) {
  const used = usedByMonth(rows);
  const months = Array.from({ length: WINDOW }, (_, k) => ymOf(idx(month) - WINDOW + k));
  const s = spikeOf(months.map((m) => ({ month: m, used: used[m] ?? null })));
  if (!s) return null;
  const last = ymOf(idx(month) - 1);
  const three = [ymOf(idx(month) - 3), ymOf(idx(month) - 2)];
  return s.month !== last && three.includes(s.month) ? s.month : null;
}

// THE RATE: the higher of last month and the 3-month average, the average
// taken without the skipped month. detail: 'YYYY-MM=u,...' from the query (a
// paired negative month appears as its two halves). Returns the average, the
// months in it, and the rate.
export function rateWithout(lastm, detail, skip) {
  const vals = String(detail || '').split(',').filter(Boolean)
    .map((p) => { const [m, u] = p.split('='); return { m, u: Number(u) }; })
    .filter((x) => x.m !== skip && Number.isFinite(x.u));
  const avg = vals.length ? vals.reduce((a, x) => a + x.u, 0) / vals.length : null;
  const last = lastm == null ? null : Number(lastm);
  const rate = last > 0 && avg > 0 ? Math.max(last, avg) : last > 0 ? last : (avg ?? 0);
  return { avg, months: vals.length, rate };
}
