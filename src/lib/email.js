// The weekly email. Action first, reference second, nothing else.
//
// Design rules that are not negotiable, learned the expensive way:
//  - Name the exact items and the exact date. Vague warnings hand back the
//    "I didn't know" excuse, which is the thing this exists to remove.
//  - Sort by deadline, not alphabetically.
//  - Say nothing when there is nothing due. A weekly email that always fires
//    gets filtered within a month.

const NAVY = '#1B3A5C', DEEP = '#142D48', GREEN = '#5FB946';
const SLATE = '#6B7280', CLOUD = '#F4F5F7', BORDER = '#E5E7EB', BODY = '#374151';
const RED = '#8F231A', RED_BG = '#FBE7E4', AMBER = '#8A5B00', AMBER_BG = '#FBF0D8';
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

function chip(row) {
  if (row.state === 'MISSED') return [RED, RED_BG, 'OVERDUE'];
  const d = row.days_to_due;
  if (d <= 0) return [RED, RED_BG, 'TODAY'];
  if (d <= 3) return [RED, RED_BG, `${d} DAY${d > 1 ? 'S' : ''}`];
  return [AMBER, AMBER_BG, `${d} DAYS`];
}

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
  const strap = forShip
    ? `Week of ${fmt(today)} &middot; ${act.length} to raise${missed ? ` &middot; ${missed} already overdue` : ''}`
    : `Week of ${fmt(today)} &middot; ${act.length} to raise${missed ? ` &middot; ${missed} already overdue` : ''} &middot; ${clean} ships clear`;
  const intro = forShip
    ? 'Everything below is for your ship and closes within the next seven days. Raise each order in OBP <strong>before the date shown</strong>.'
    : 'Only ships with an order due in the next seven days are listed. If your ship is here, raise the order in OBP <strong>before the date shown</strong>.';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Orders due this week</title></head>
<body style="margin:0;padding:0;background:${CLOUD};" bgcolor="${CLOUD}">
<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;">${act.length} order${act.length === 1 ? '' : 's'} to raise before the container closes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CLOUD}"><tr><td align="center" style="padding:26px 10px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;max-width:620px;">

<tr><td style="padding:0;font-size:0;line-height:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="60%" height="4" bgcolor="${NAVY}" style="background:${NAVY};font-size:0;line-height:0;height:4px;">&nbsp;</td>
<td width="40%" height="4" bgcolor="${GREEN}" style="background:${GREEN};font-size:0;line-height:0;height:4px;">&nbsp;</td>
</tr></table></td></tr>

<tr><td bgcolor="${DEEP}" style="background:${DEEP};padding:22px 26px;">
<div style="font-family:${FH};font-size:20px;font-weight:700;letter-spacing:5px;color:#FFFFFF;line-height:1;">CIMS</div>
<div style="width:78px;height:2px;background:${GREEN};font-size:0;line-height:0;margin:8px 0 5px;">&nbsp;</div>
<div style="font-family:${FH};font-size:7px;font-weight:600;letter-spacing:2.2px;color:#95A0AD;line-height:1;">CRUISE INDUSTRY MANAGED SERVICES</div>
</td></tr>

<tr><td style="padding:26px 26px 6px;">
<div style="font-family:${FH};font-size:22px;font-weight:600;color:${NAVY};line-height:1.25;">${heading}</div>
<div style="font-family:${FB};font-size:12px;color:${SLATE};padding-top:6px;">${strap}</div>
</td></tr>

<tr><td style="padding:16px 26px 0;font-family:${FB};font-size:14px;line-height:1.65;color:${BODY};">
<p style="margin:0 0 12px;">${intro}</p>
<p style="margin:0 0 2px;">The due date is the last day the ship's inventory manager will accept an order for that container. After it, nothing can be added &mdash; it becomes an emergency shipment. An order without a PO is not an order.</p>
</td></tr>

<tr><td style="padding:22px 22px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>

<tr><td style="padding:22px 26px 0;font-family:${FB};font-size:14px;line-height:1.65;color:${BODY};">
<p style="margin:0 0 14px;">${forShip ? 'Nothing else closes for you this week.' : 'Not listed means nothing closes for you this week.'} Next run: <strong>Monday 08:00 Miami time</strong>.</p>
<p style="margin:0;">Thank you,<br><strong>Ray Guerra</strong><br><span style="color:${SLATE};">Supply Chain Manager &middot; DG3 Diversified Global Graphics Group</span></p>
</td></tr>

<tr><td style="padding:22px 26px 28px;"><div style="border-top:1px solid ${BORDER};padding-top:13px;font-family:${FB};font-size:11px;line-height:1.65;color:#9CA3AF;">
Due dates come from your ship's Ordering Schedule (Azamara: Delivery date to BWS on the monthly MLS). A voyage counts as ordered when an open order in OBP arrives on that loading date. If a line looks wrong, reply and the source will be checked before the next run.
</div></td></tr>

</table></td></tr></table></body></html>`;
}
