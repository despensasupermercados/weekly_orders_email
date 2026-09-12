// The weekly email. Action first, reference second, nothing else.
//
// Design rules that are not negotiable, learned the expensive way:
//  - Name the exact items and the exact date. Vague warnings hand back the
//    "I didn't know" excuse, which is the thing this exists to remove.
//  - Sort by deadline, not alphabetically.
//  - Say nothing when there is nothing due. A weekly email that always fires
//    gets filtered within a month.

// BRAND TOKENS ARE NOT A PALETTE TO TASTE. These are the values in
// EMAIL-CONVENTION section 3, and three of them had drifted here: cloud was
// #F4F5F7, red was #8F231A, amber was #8A5B00. Small drifts are exactly how
// fifteen competing letterheads happened once already.
import { mastRows } from '../cims-mast.js';
import { byFleetOrder } from './fleetStatus.js';

const NAVY = '#1B3A5C', DEEP = '#142D48', GREEN = '#5FB946', GREEN_INK = '#3E7F2E';
const SLATE = '#6B7280', CLOUD = '#F3F4F6', BORDER = '#E5E7EB', BODY = '#374151';
const RED = '#96281B', RED_BG = '#FBE7E4', AMBER = '#B7791F', AMBER_BG = '#FBF0D8';
const GREY = '#9CA3AF';
const FH = "'Outfit',Helvetica,Arial,sans-serif";
const FB = "'DM Sans',Helvetica,Arial,sans-serif";

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = (isoDate) => {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ONE CODE, NOT THREE. [recQ2a7KrEQhosimV, point 3]: "The three-state legend is
// the same red / yellow / green language as OBP and as the weekly email. Keep
// the language consistent across all three so the crew learn one code, not
// three." The crew already read below / correct / above on the statistics file
// and in OBP.
//
// This email used RED for anything inside three days and AMBER beyond it, and
// NO GREEN ANYWHERE. Every row a printer saw was an alarm colour, there was no
// "you are covered" state at all, and the vocabulary was a third one they had
// to learn on top of the two they use. Red for a deadline five days out also
// spends the colour that has to mean "too late" - after which nothing is left
// to say it with.
// THE WORDS ARE A REMINDER, NOT A LESSON. Each state carried a full clause of
// explanation - "past the cut-off, or nothing on board" - which wrapped to two
// lines and pushed the first real row off the first screen. The colour is the
// code the crew already read on OBP; two or three words is all the key needs.
export const LEGEND = [
  [RED, RED_BG, 'LATE', 'past the due date'],
  [AMBER, AMBER_BG, 'ORDER NOW', 'before the due date'],
  [GREEN_INK, '#EAF5E6', 'OK', 'on order'],
];

function chip(row) {
  // RED is reserved for past the cut-off. Nothing a crew can still act on is
  // red, because then red stops meaning "too late".
  if (row.state === 'MISSED') return [RED, RED_BG, 'OVERDUE'];
  if (row.state === 'ORDERED') return [GREEN_INK, '#EAF5E6', 'ORDERED'];
  const d = row.days_to_due;
  if (d <= 0) return [RED, RED_BG, 'TODAY'];
  return [AMBER, AMBER_BG, d === 1 ? '1 DAY' : `${d} DAYS`];
}

// Stated in the email, in the crew's own words, so the colour is readable by
// someone who has never seen this email before.
const legendHtml = () => `
<tr><td style="padding:12px 26px 0;font-family:${FB};font-size:11px;color:${SLATE};line-height:2.1;">${
  LEGEND.map(([fg, bg, label, what]) =>
    `<span style="white-space:nowrap;"><span style="font-weight:700;letter-spacing:.4px;color:${fg};background:${bg};padding:2px 6px;">${label}</span> ${what}</span>`
  ).join('&nbsp;&nbsp; ')}</td></tr>`;

function rowHtml(row, i) {
  const [fg, bg, label] = chip(row);
  const zb = i % 2 ? '#FAFBFC' : '#FFFFFF';
  const moved = row.date_changed
    ? `<div style="font-family:${FB};font-size:12px;color:${RED};padding-top:3px;">Due date moved since the last schedule &mdash; check it.</div>`
    : '';
  const what = row.state === 'MISSED'
    ? 'No order raised and the due date has passed.'
    : 'No order raised yet.';
  return `<tr><td bgcolor="${zb}" style="background:${zb};border-left:4px solid ${fg};padding:14px;border-bottom:1px solid ${BORDER};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${FH};font-size:16px;font-weight:600;color:${NAVY};">${esc(row.ship)}</td>
      <td align="right"><span style="display:inline-block;background:${bg};color:${fg};font-family:${FB};font-size:11px;font-weight:700;letter-spacing:.8px;padding:4px 10px;">${label}</span></td>
    </tr></table>
    <div style="font-family:${FB};font-size:14px;color:${BODY};padding-top:4px;">${what}</div>
    <div style="font-family:${FB};font-size:12px;color:${SLATE};padding-top:6px;line-height:1.5;">
      Order due <strong style="color:${fg};">${fmt(row.due_date)}</strong>
      &middot; loads ${esc(row.loading_port || 'TBC')} ${fmt(row.loading_delivery_date)}
      ${row.voyage ? `&middot; ${esc(row.voyage)}` : ''}
    </div>${moved}
  </td></tr>`;
}

// audience 'fleet' is the dry-run digest to Miguel and Ray and lists every ship.
// audience 'ship' is what a printer actually receives: their vessel only, no
// fleet counts, no other ship's business. The two must never be confused - a
// crew member reading a fleet-wide table looks for their own line, does not
// THE SIX-MONTH GRID. The Brain's locked decision for this email is "action
// list first, SIX-MONTH GRID AS REFERENCE", and the grid was simply missing:
// the email showed only what closes in the next seven days.
//
// Why it matters more than it looks. The action list answers "what do I do this
// week". The grid answers the question a printer actually has - "when is my next
// one, and did I already cover it" - and it is the only place a ship can see the
// biweekly cadence, which is the thing nobody believes until they see their own
// loadings sitting 25 to 28 days apart. It also makes an expired schedule
// visible as empty months rather than as silence.
const MON_LABEL = (d) => `${MONTHS[d.getMonth()]}`;

// Six months starting with the month `today` falls in.
function monthKeys(today) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push({ key: d.toISOString().slice(0, 7), label: MON_LABEL(d), year: d.getUTCFullYear() });
  }
  return out;
}

// COVERAGE, NOT A TABLE OF LABELS.
//
// The first version was a grid of chips reading "12 ordered", "26 skip". Three
// things were wrong with it and only one was cosmetic.
//
// 1. "12 ordered" IS A DATE AND READS AS A QUANTITY. The 12th, ordered. A
//    printer scanning it sees twelve units ordered. There is no worse failure
//    in an operational email than a number that means something else.
// 2. "skip" IS NOT DATA. It is the absence of an obligation, and it filled half
//    the grid. Forty-odd cells telling the reader "this one does not concern
//    you" is forty-odd cells of nothing.
// 3. EVERY CELL HAD EQUAL WEIGHT. About 130 green chips and three amber ones,
//    so the eye had nowhere to land and the three that mattered were the
//    hardest to find. That is the catalogued failure: eight hues when the
//    story is one number. The fix is EMPHASIS - quiet everything that is fine,
//    and let the holes be the only thing carrying colour.
//
// So: ships that are covered every month collapse into ONE LINE of names. Only
// ships with a hole get a row. The row is six fixed cells, equal height, months
// anchored above them, so the eye tracks straight down a column. Nothing inside
// a covered cell - there is nothing to say about it.
const monthsOf = (rows) => {
  const by = new Map();
  for (const r of rows) {
    if (!r.loading_delivery_date) continue;
    const k = r.loading_delivery_date.slice(0, 7);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return by;
};

// What one ship's month cell has to say. Order matters: an action outranks
// coverage, because a month can hold both.
function cellState(rowsThisMonth, gapsThisMonth) {
  const act = rowsThisMonth.find((r) => r.state === 'MISSED')
    || rowsThisMonth.find((r) => r.state === 'DUE NOW');
  if (act) {
    const day = Number(act.loading_delivery_date.slice(8, 10));
    return act.state === 'MISSED'
      ? { bg: RED_BG, fg: RED, text: `${day} late` }
      : { bg: AMBER_BG, fg: AMBER, text: `${day} order` };
  }
  if (gapsThisMonth.length) return { bg: AMBER_BG, fg: AMBER, text: 'gap' };
  if (rowsThisMonth.some((r) => r.state === 'ORDERED')) {
    return { bg: '#EAF5E6', fg: GREEN_INK, text: '' };
  }
  return null; // nothing scheduled: normal this far out, and it stays quiet
}

function coverageHtml(all, today, forShip, shipName, gaps) {
  const months = monthKeys(today);
  const keys = new Set(months.map((m) => m.key));
  const rows = all.filter((r) => r.loading_delivery_date && keys.has(r.loading_delivery_date.slice(0, 7))
    && (!forShip || r.ship === shipName));
  if (!rows.length) return '';

  const gapList = (gaps || []).filter((g) => !forShip || g.ship === shipName);
  const ships = [...new Set(rows.map((r) => r.ship))].sort(byFleetOrder);

  const built = ships.map((ship) => {
    const by = monthsOf(rows.filter((r) => r.ship === ship));
    const cells = months.map((mo) => cellState(
      by.get(mo.key) || [],
      gapList.filter((g) => g.ship === ship && String(g.next_delivery || '').slice(0, 7) === mo.key)));
    return { ship, cells, needsEye: cells.some((c) => c && c.text) };
  });

  // EMPHASIS. A ship with nothing to act on is a name, not a row.
  const calm = built.filter((b) => !b.needsEye);
  const loud = built.filter((b) => b.needsEye);

  const W = Math.floor(64 / months.length);
  // THE YEAR, ONCE, WHERE IT CHANGES. Repeating "26" on all six columns is five
  // characters of noise per row of the header; dropping it entirely leaves a
  // reader guessing which January. Mark it only when it turns over.
  const y0 = months[0].year;
  const head = months.map((mo) =>
    `<th width="${W}%" align="center" style="font-family:${FB};font-size:10px;font-weight:700;letter-spacing:.8px;` +
    `color:${SLATE};padding:0 2px 6px;white-space:nowrap;">${mo.label.toUpperCase()}` +
    (mo.year !== y0 ? `<span style="font-weight:400;color:#B6BCC4;"> '${String(mo.year).slice(2)}</span>` : '') +
    `</th>`).join('');

  // A CALM WEEK IS ONE LINE, NOT TWENTY-TWO ROWS. If no ship has anything to act
  // on, a full grid of green says exactly what a sentence says, at twenty times
  // the length, and trains the reader to scroll past the section for good. A
  // ship's own email always keeps its row: one row is its whole reference.
  if (!forShip && !loud.length) {
    return `
<tr><td style="padding:26px 26px 0;">
<div style="font-family:${FH};font-size:13px;font-weight:600;color:${NAVY};padding:0 0 3px;">Coverage &mdash; next six months</div>
<div style="font-family:${FB};font-size:13px;color:${BODY};">All <strong>${built.length}</strong> ships have stock arriving every month to ${months[months.length - 1].label} ${months[months.length - 1].year}. Nothing outstanding.</div>
</td></tr>`;
  }

  const body = (loud.length ? loud : built).map((b, i) => {
    const zb = i % 2 ? '#FAFBFC' : '#FFFFFF';
    const cells = b.cells.map((c) => {
      if (!c) {
        return `<td align="center" bgcolor="${zb}" style="background:${zb};padding:5px 2px;">` +
          `<div style="height:20px;line-height:20px;font-family:${FB};font-size:11px;color:#D7DBE0;">&middot;</div></td>`;
      }
      return `<td align="center" bgcolor="${zb}" style="background:${zb};padding:5px 2px;">` +
        `<div bgcolor="${c.bg}" style="background:${c.bg};height:20px;line-height:20px;font-family:${FB};` +
        `font-size:11px;font-weight:${c.text ? 700 : 400};color:${c.fg};white-space:nowrap;">${c.text || '&nbsp;'}</div></td>`;
    }).join('');
    return `<tr><td bgcolor="${zb}" style="background:${zb};padding:5px 8px 5px 2px;font-family:${FB};` +
      `font-size:13px;font-weight:600;color:${NAVY};white-space:nowrap;">${esc(b.ship)}</td>${cells}</tr>`;
  }).join('');

  const calmLine = (loud.length && calm.length)
    ? `<div style="font-family:${FB};font-size:12px;color:${SLATE};padding:10px 4px 0;">` +
      `<strong style="color:${GREEN_INK};">${calm.length} ship${calm.length === 1 ? '' : 's'} covered every month:</strong> ` +
      `${calm.map((b) => esc(b.ship)).join(', ')}.</div>`
    : '';

  const title = forShip ? 'Your next six months' : 'Coverage &mdash; next six months';
  return `
<tr><td style="padding:26px 22px 0;">
<div style="font-family:${FH};font-size:13px;font-weight:600;color:${NAVY};padding:0 4px 3px;">${title}</div>
<div style="font-family:${FB};font-size:11px;color:${SLATE};padding:0 4px 10px;">Green means stock is on the way. Nothing to do here today.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;">
<tr><th align="left" style="font-family:${FB};font-size:10px;font-weight:700;letter-spacing:.8px;color:${SLATE};padding:0 8px 6px 2px;">SHIP</th>${head}</tr>
${body}
</table>${calmLine}</td></tr>`;
}

// WILL YOU RUN OUT BEFORE THE NEXT CONTAINER. The section that matches the
// objective's demand for "these exact items":
//
//   "You have an order coming Wednesday, and you're going to run out of black
//    toner. You either fix it now, or you wait until the next biweekly order."
//
// It reports a DATE, never a quantity. Par is what should be aboard and an
// order line is a different number; the crew turns two facts - what is on
// board, what it burns a month - into an order in seconds.
function runsOutHtml(findings, forShip, shipName) {
  const list = (findings || []).filter((f) => !forShip || f.ship === shipName);
  if (!list.length) return '';
  const rows = list.map((f, i) => {
    const zb = i % 2 ? '#FAFBFC' : '#FFFFFF';
    // RED only when nothing at all is on order for it. If something is coming,
    // late is amber: the crew can still add a line to an open order.
    const [fg, bg, label] = f.next_loading
      ? [AMBER, AMBER_BG, 'ADD NOW']
      : [RED, RED_BG, 'NOT ON ORDER'];
    // The ship name is redundant on a ship's own email, and repeating it on
    // every row is the kind of noise that makes a page feel long.
    const who = forShip ? esc(f.item) : `${esc(f.ship)} &middot; ${esc(f.item)}`;
    return `<tr><td bgcolor="${zb}" style="background:${zb};padding:10px;border-bottom:1px solid ${BORDER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${FB};font-size:13px;font-weight:600;color:${NAVY};">${who}</td>
<td align="right"><span style="font-family:${FB};font-size:10px;font-weight:700;letter-spacing:.5px;color:${fg};background:${bg};padding:2px 6px;white-space:nowrap;">${label}</span></td>
</tr></table>
<div style="font-family:${FB};font-size:12px;color:${BODY};padding-top:3px;"><strong>${f.on_hand}</strong> on board &middot; uses <strong>${Math.round(f.rate)}</strong> a month &middot; empty about <strong>${fmt(f.stockout)}</strong></div>
<div style="font-family:${FB};font-size:12px;color:${f.next_loading ? SLATE : RED};padding-top:2px;">${f.next_loading
      ? `Next delivery ${fmt(f.next_loading)}. Add it to that order.`
      : 'Nothing on order for it.'}</div>
</td></tr>`;
  }).join('');
  const title = forShip ? 'You will run out of these' : 'Running out before the next delivery';
  return `
<tr><td style="padding:24px 22px 0;">
<div style="font-family:${FH};font-size:13px;font-weight:600;color:${NAVY};padding:0 4px 3px;">${title}</div>
<div style="font-family:${FB};font-size:11px;color:${SLATE};padding:0 4px 10px;">Adding a line to an order that is still open costs nothing. Miss it and the ship waits for the next loading.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${BORDER};">${rows}</table>
</td></tr>`;
}

// SHIPS WITH NO ORDERING SCHEDULE. 25 of 48 have none, and until now they got
// nothing at all - which reads exactly like "nothing is due for you". The
// objective record calls that out by name: silence is how an order gets
// forgotten and an emergency shipment gets paid.
//
// This section is deliberately quieter than the action list above it. Without a
// schedule there is no due date, so it can never say "order by". It asks a
// question of someone who knows the answer, and says on its face that the
// evidence is thinner. An instruction we cannot stand behind would cost more
// credibility than the warning is worth.
function gapsHtml(gaps, forShip, shipName) {
  const list = (gaps || []).filter((g) => !forShip || g.ship === shipName);
  if (!list.length) return '';
  const rows = list.map((g, i) => {
    const zb = i % 2 ? '#FAFBFC' : '#FFFFFF';
    return `<tr><td bgcolor="${zb}" style="background:${zb};padding:9px 10px;border-bottom:1px solid ${BORDER};">
<div style="font-family:${FB};font-size:13px;font-weight:600;color:${NAVY};">${esc(g.ship)}</div>
<div style="font-family:${FB};font-size:12px;color:${BODY};padding-top:2px;">Nothing arrives between <strong>${fmt(g.after_delivery)}</strong> and <strong>${fmt(g.next_delivery)}</strong> &mdash; ${g.gap_days} days, against this ship's usual ${g.own_interval}.</div>
</td></tr>`;
  }).join('');
  const title = forShip ? 'A gap in your deliveries' : 'Ships with no ordering schedule';
  return `
<tr><td style="padding:24px 22px 0;">
<div style="font-family:${FH};font-size:13px;font-weight:600;color:${NAVY};padding:0 4px 3px;">${title}</div>
<div style="font-family:${FB};font-size:11px;color:${SLATE};padding:0 4px 10px;">Read from open orders only, because no ordering schedule is loaded for ${forShip ? 'your ship' : 'these ships'}. There is no due date to quote, so this is a question rather than an instruction: <strong>if a loading in that gap was meant to be ordered, it has not been.</strong></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${BORDER};">${rows}</table>
</td></tr>`;
}

// find it quickly, and stops opening the email.
export function renderWeekly(act, all, today, opts = {}) {
  const forShip = opts.audience === 'ship';
  const shipName = opts.ship || '';
  const missed = act.filter((r) => r.state === 'MISSED').length;
  const rows = act.map(rowHtml).join('');
  // "102 ships clear" ON A 48-SHIP FLEET. This counted ORDERED **voyages** and
  // printed them as ships, so the header of the email announced a number that
  // cannot exist. A reader who spots that stops believing the rest of the page,
  // and they are right to. Count ships.
  const troubled = new Set([
    ...act.map((r) => r.ship),
    ...(opts.runsOut || []).map((f) => f.ship),
    ...(opts.gaps || []).map((g) => g.ship),
  ]);
  const clean = [...new Set(all.map((r) => r.ship))].filter((sh) => !troubled.has(sh)).length;
  // WRITTEN FOR THE PERSON WHO READS IT. The crew are Filipino printer
  // specialists reading English as a second language, often on a phone, at the
  // start of a shift. The old version opened with two dense paragraphs of
  // policy before a single actionable line, and sentences like "the last day
  // the ship's inventory manager will accept an order for that container" -
  // three subordinate clauses deep.
  //
  // Short words. One idea a line. The instruction first, the policy in the
  // small print at the bottom where it belongs. Everything the reader needs in
  // the first screen: is there something for me, what, and by when.
  // A SHIP WHOSE ONLY FINDING IS A DELIVERY GAP MUST NOT READ "0 to do". That
  // is the header contradicting the body, and the body is the part that matters.
  const gapCount = (opts.gaps || []).filter((g) => !forShip || g.ship === shipName).length;
  const dryCount = (opts.runsOut || []).filter((f) => !forShip || f.ship === shipName).length;
  const todo = act.length + dryCount + gapCount;
  const heading = forShip
    ? `${esc(shipName)} &mdash; ${todo} to do`
    : `Orders due &mdash; ${fmt(today)}`;
  const gapBit = gapCount ? ` &middot; ${gapCount} gap${gapCount === 1 ? '' : 's'} to confirm` : '';
  const dryBit = dryCount ? ` &middot; ${dryCount} running out` : '';
  const bits = [
    act.length ? `${act.length} to order` : null,
    missed ? `${missed} late` : null,
    dryCount ? `${dryCount} running out` : null,
    gapCount ? `${gapCount} to check` : null,
  ].filter(Boolean);
  const strap = forShip
    ? (bits.join(' &middot; ') || 'Nothing to do this week')
    : `${bits.join(' &middot; ') || 'Nothing due'} &middot; ${clean} of ${new Set(all.map((r) => r.ship)).size} ships clear`;
  const intro = 'Order in OBP <strong>before the date shown</strong>.';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Orders due this week</title></head>
<body style="margin:0;padding:0;background:${CLOUD};" bgcolor="${CLOUD}">
<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;">${act.length} order${act.length === 1 ? '' : 's'} to raise before the container closes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CLOUD}"><tr><td align="center" style="padding:26px 10px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;max-width:620px;">

${mastRows()}

<tr><td style="padding:26px 26px 6px;">
<div style="font-family:${FH};font-size:22px;font-weight:600;color:${NAVY};line-height:1.25;">${heading}</div>
<div style="font-family:${FB};font-size:12px;color:${SLATE};padding-top:6px;">${strap}</div>
</td></tr>
${legendHtml()}

<tr><td style="padding:14px 26px 0;font-family:${FB};font-size:15px;line-height:1.5;color:${BODY};">
<p style="margin:0;">${intro}</p>
</td></tr>

<tr><td style="padding:22px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>

${runsOutHtml(opts.runsOut, forShip, shipName)}
${gapsHtml(opts.gaps, forShip, shipName)}
${coverageHtml(all, today, forShip, shipName, opts.gaps)}

<tr><td style="padding:22px 26px 0;font-family:${FB};font-size:14px;line-height:1.65;color:${BODY};">
<p style="margin:0 0 14px;">${forShip ? 'Nothing else closes for you this week.' : 'Not listed means nothing closes for you this week.'} Next run: <strong>Monday 08:00 Miami time</strong>.</p>
<p style="margin:0;">Thank you,<br><strong>Ray Guerra</strong><br><span style="color:${SLATE};">Supply Chain Manager &middot; DG3 Diversified Global Graphics Group</span></p>
</td></tr>

<tr><td style="padding:22px 26px 28px;"><div style="border-top:1px solid ${BORDER};padding-top:13px;font-family:${FB};font-size:11px;line-height:1.65;color:#9CA3AF;">
<strong>After the due date, nothing can be added to that container.</strong> It becomes an emergency shipment.<br>
<strong>No PO means no order.</strong><br><br>
Dates come from your ship's Ordering Schedule. Azamara uses the BWS delivery date on Ray's monthly schedule. A loading counts as ordered when an open order in OBP arrives on that date. If a line looks wrong, reply and we check it before the next run.
</div></td></tr>

</table></td></tr></table></body></html>`;
}
