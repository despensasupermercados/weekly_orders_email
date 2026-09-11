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
export const LEGEND = [
  [RED, RED_BG, 'Below', 'past the cut-off, or nothing on board'],
  [AMBER, AMBER_BG, 'Order now', 'below the required amount for this loading'],
  [GREEN_INK, '#EAF5E6', 'Correct', 'an order is raised and arriving'],
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
<tr><td style="padding:14px 26px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${LEGEND.map(([fg, bg, label, what]) =>
  `<td style="padding:0 14px 0 0;"><span style="font-family:${FB};font-size:10px;font-weight:600;color:${fg};background:${bg};padding:2px 6px;">${label}</span>` +
  `<span style="font-family:${FB};font-size:10px;color:${SLATE};padding-left:5px;">${what}</span></td>`).join('')}</tr></table>
</td></tr>`;

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
const MON_LABEL = (d) => `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;

const CELL = {
  ORDERED:          [GREEN_INK, '#EAF5E6', 'ordered'],
  'DUE NOW':        [AMBER,     AMBER_BG,  'due'],
  MISSED:           [RED,       RED_BG,    'missed'],
  PO_NOT_RECORDED:  [SLATE,     CLOUD,     'PO?'],
  upcoming:         [SLATE,     '#FFFFFF', 'due'],
  skippable:        [GREY,      '#FFFFFF', 'skip'],
  past:             [GREY,      '#FFFFFF', 'past'],
  NO_DUE_DATE:      [RED,       RED_BG,    'no date'],
  NO_LOADING_DATE:  [RED,       RED_BG,    'no date'],
};

// Six months starting with the month `today` falls in.
function monthKeys(today) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push({ key: d.toISOString().slice(0, 7), label: MON_LABEL(d) });
  }
  return out;
}

function gridHtml(all, today, forShip, shipName) {
  const months = monthKeys(today);
  const inWindow = all.filter((r) => r.loading_delivery_date
    && months.some((mo) => r.loading_delivery_date.startsWith(mo.key))
    && (!forShip || r.ship === shipName));
  if (!inWindow.length) return '';

  const ships = [...new Set(inWindow.map((r) => r.ship))].sort();
  const head = months.map((mo) =>
    `<th align="center" style="font-family:${FB};font-size:10px;font-weight:600;letter-spacing:.6px;` +
    `text-transform:uppercase;color:${SLATE};padding:0 4px 7px;">${mo.label}</th>`).join('');

  const body = ships.map((ship, i) => {
    const zb = i % 2 ? '#FAFBFC' : '#FFFFFF';
    const cells = months.map((mo) => {
      const hits = inWindow
        .filter((r) => r.ship === ship && r.loading_delivery_date.startsWith(mo.key))
        .sort((a, b) => (a.loading_delivery_date < b.loading_delivery_date ? -1
          : a.loading_delivery_date > b.loading_delivery_date ? 1 : 0));
      if (!hits.length) {
        return `<td align="center" bgcolor="${zb}" style="background:${zb};padding:6px 4px;` +
          `font-family:${FB};font-size:11px;color:${BORDER};">&mdash;</td>`;
      }
      const pills = hits.map((r) => {
        const [fg, bg, label] = CELL[r.state] || [SLATE, '#FFFFFF', r.state];
        const day = Number(r.loading_delivery_date.slice(8, 10));
        return `<div style="font-family:${FB};font-size:10px;line-height:1.35;color:${fg};` +
          `background:${bg};padding:2px 5px;margin:1px 0;white-space:nowrap;">` +
          `${day} ${label}</div>`;
      }).join('');
      return `<td align="center" bgcolor="${zb}" style="background:${zb};padding:5px 4px;">${pills}</td>`;
    }).join('');
    return `<tr><td bgcolor="${zb}" style="background:${zb};padding:6px 8px 6px 2px;font-family:${FB};` +
      `font-size:12px;font-weight:600;color:${NAVY};white-space:nowrap;">${esc(ship)}</td>${cells}</tr>`;
  }).join('');

  const title = forShip ? 'Your next six months' : 'The fleet, next six months';
  return `
<tr><td style="padding:26px 22px 0;">
<div style="font-family:${FH};font-size:13px;font-weight:600;color:${NAVY};padding:0 4px 3px;">${title}</div>
<div style="font-family:${FB};font-size:11px;color:${SLATE};padding:0 4px 10px;">Loading dates, not due dates. <strong>skip</strong> is a loading your ship does not use &mdash; the cadence is every other one.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<tr><th align="left" style="font-family:${FB};font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:${SLATE};padding:0 8px 7px 2px;">Ship</th>${head}</tr>
${body}
</table></td></tr>`;
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
  const clean = all.filter((r) => r.state === 'ORDERED').length;
  const heading = forShip
    ? `${esc(shipName)} &mdash; order before your container closes`
    : 'Order before your container closes';
  // A SHIP WHOSE ONLY FINDING IS A DELIVERY GAP MUST NOT READ "0 to raise".
  // That is the header contradicting the body, and the body is the part that
  // matters.
  const gapCount = (opts.gaps || []).filter((g) => !forShip || g.ship === shipName).length;
  const gapBit = gapCount ? ` &middot; ${gapCount} gap${gapCount === 1 ? '' : 's'} to confirm` : '';
  const strap = forShip
    ? `Week of ${fmt(today)} &middot; ${act.length} to raise${missed ? ` &middot; ${missed} already overdue` : ''}${gapBit}`
    : `Week of ${fmt(today)} &middot; ${act.length} to raise${missed ? ` &middot; ${missed} already overdue` : ''}${gapBit} &middot; ${clean} ships clear`;
  const intro = forShip
    ? 'Everything below is for your ship and closes within the next seven days. Raise each order in OBP <strong>before the date shown</strong>.'
    : 'Only ships with an order due in the next seven days are listed. If your ship is here, raise the order in OBP <strong>before the date shown</strong>.';

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

<tr><td style="padding:16px 26px 0;font-family:${FB};font-size:14px;line-height:1.65;color:${BODY};">
<p style="margin:0 0 12px;">${intro}</p>
<p style="margin:0 0 2px;">The due date is the last day the ship's inventory manager will accept an order for that container. After it, nothing can be added &mdash; it becomes an emergency shipment. An order without a PO is not an order.</p>
</td></tr>

<tr><td style="padding:22px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>

${gapsHtml(opts.gaps, forShip, shipName)}
${gridHtml(all, today, forShip, shipName)}

<tr><td style="padding:22px 26px 0;font-family:${FB};font-size:14px;line-height:1.65;color:${BODY};">
<p style="margin:0 0 14px;">${forShip ? 'Nothing else closes for you this week.' : 'Not listed means nothing closes for you this week.'} Next run: <strong>Monday 08:00 Miami time</strong>.</p>
<p style="margin:0;">Thank you,<br><strong>Ray Guerra</strong><br><span style="color:${SLATE};">Supply Chain Manager &middot; DG3 Diversified Global Graphics Group</span></p>
</td></tr>

<tr><td style="padding:22px 26px 28px;"><div style="border-top:1px solid ${BORDER};padding-top:13px;font-family:${FB};font-size:11px;line-height:1.65;color:#9CA3AF;">
Due dates come from your ship's Ordering Schedule (Azamara: Delivery date to BWS on the monthly MLS). A voyage counts as ordered when an open order in OBP arrives on that loading date. If a line looks wrong, reply and the source will be checked before the next run.
</div></td></tr>

</table></td></tr></table></body></html>`;
}
