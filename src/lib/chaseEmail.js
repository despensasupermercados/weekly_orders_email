// The "send your Ordering Schedule file" chase. Miguel, 17 Sep 2026: one
// email per ship, Ray in cc, always a 24-hour turnaround, mock-up approved.
//
// Written for a crew that does not read: one headline, one deadline, three
// numbered steps, the address in large type. A red box at the top says why
// THIS ship is getting the mail, in one sentence. The table at the bottom
// lists every ship still missing, with the reader's own row highlighted, so
// nobody thinks they were singled out. Ray signs it; replies go to him
// (REPLY_TO); files go only to obp@cims.work, which is cims-hon's ingest.
//
// Same letterhead and Outlook rules as the weekly email: the canonical mast,
// tables and inline styles only, bgcolor paired with background, no rgba, no
// gradients, webfonts with Helvetica/Arial fallbacks.

import { mastRows } from '../cims-mast.js';
import { STATUS } from './scheduleStatus.js';
import { normShip } from './fleet.js';

export const CHASE_TEMPLATE = 'ordering-schedule-chase';
export const CHASE_HOURS = 24;
export const SCHEDULE_INBOX = 'obp@cims.work';

const NAVY = '#1B3A5C', DEEP = '#142D48', GINK = '#3E7F2E', SLATE = '#6B7280';
const CLOUD = '#F3F4F6', BORDER = '#E5E7EB', BODY = '#374151', RED = '#96281B', RED_BG = '#FDF2F0', HL = '#FFF4CC';
const FH = "'Outfit',Helvetica,Arial,sans-serif";
const FB = "'DM Sans',Helvetica,Arial,sans-serif";
const FM = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One short line per state, the words the crew read. Under twelve words each.
export const WHY = {
  [STATUS.NEVER]: 'We never got your file.',
  [STATUS.NOFILE]: 'Your email had no file in it.',
  [STATUS.IMAGE]: 'You sent a picture. We need the Excel file.',
  [STATUS.UNREADABLE]: 'Your file opened empty. Send the original from your Inventory Manager.',
  [STATUS.UNMATCHED]: 'Your file name has no ship name. Rename it.',
  [STATUS.WRONGTYPE]: 'You sent a PDF or other file. We need the Excel file.',
  [STATUS.STALE]: 'Your schedule has ended. Send the new one.',
};

// 24 hours after the send, in UTC, spelled out. "Friday 18 September, 14:00 UTC".
export function chaseDeadline(sentAtMs, hours = CHASE_HOURS) {
  const d = new Date(sentAtMs + hours * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    iso: d.toISOString(),
    text: `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`,
  };
}

export const chaseSubject = (ship) => `${ship}: send your Ordering Schedule file within ${CHASE_HOURS} hours`;

const step = (n, title, body) => `
<tr><td style="padding:0 0 14px 0;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td width="44" valign="top" style="padding:0 12px 0 0;">
   <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="44" height="44" align="center" valign="middle" bgcolor="${NAVY}" style="background:${NAVY};width:44px;height:44px;font-family:${FH};font-size:22px;font-weight:700;color:#FFFFFF;line-height:44px;">${n}</td>
   </tr></table>
  </td>
  <td valign="top" style="padding:2px 0 0 0;">
   <div style="font-family:${FH};font-size:18px;font-weight:700;color:${DEEP};line-height:1.25;">${title}</div>
   <div style="font-family:${FB};font-size:15px;color:${BODY};line-height:1.45;padding-top:4px;">${body}</div>
  </td>
 </tr></table>
</td></tr>`;

// missing: [{ship, status}] from needsSchedule(); ship: the reader, or null
// for the fleet copy that goes to Ray and the supervisors.
export function renderChase({ ship, missing, sentAtMs, signer = 'Ray Guerra', signerTitle = 'DG3 Onboard Support' }) {
  const list = (missing || []).slice().sort((a, b) => a.ship.localeCompare(b.ship));
  const mine = ship ? list.find((m) => normShip(m.ship) === normShip(ship)) : null;
  const deadline = chaseDeadline(sentAtMs);
  const fileExample = `${ship || 'Beyond'} Ordering Schedule.xlsx`;

  const rows = list.map((m) => {
    const hl = mine && normShip(m.ship) === normShip(mine.ship);
    const bg = hl ? HL : '#FFFFFF';
    return `<tr>
<td bgcolor="${bg}" style="background:${bg};padding:8px 10px;border-bottom:1px solid ${BORDER};font-family:${FH};font-size:14px;font-weight:700;color:${DEEP};white-space:nowrap;">${esc(m.ship)}${hl ? ` <span style="color:${RED};">&larr; you</span>` : ''}</td>
<td bgcolor="${bg}" style="background:${bg};padding:8px 10px;border-bottom:1px solid ${BORDER};font-family:${FB};font-size:13px;color:${BODY};">${esc(WHY[m.status] || m.status)}</td>
</tr>`;
  }).join('');

  const yourBox = mine ? `
<tr><td style="padding:0 0 18px 0;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td width="6" bgcolor="${RED}" style="background:${RED};width:6px;font-size:0;">&nbsp;</td>
  <td bgcolor="${RED_BG}" style="background:${RED_BG};padding:12px 14px;">
   <div style="font-family:${FH};font-size:12px;font-weight:700;letter-spacing:1.5px;color:${RED};">${esc(String(mine.ship).toUpperCase())} &middot; WHY WE ARE WRITING</div>
   <div style="font-family:${FB};font-size:16px;font-weight:700;color:${DEEP};line-height:1.35;padding-top:4px;">${esc(WHY[mine.status] || mine.status)}</div>
  </td>
 </tr></table>
</td></tr>` : '';

  const title = ship ? chaseSubject(ship) : `${list.length} ships: send your Ordering Schedule file within ${CHASE_HOURS} hours`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=DM+Sans:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${CLOUD};" bgcolor="${CLOUD}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:${CLOUD};">Three steps. Excel file only. Send to ${SCHEDULE_INBOX} within ${CHASE_HOURS} hours.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CLOUD}" style="background:${CLOUD};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;width:600px;max-width:100%;">
${mastRows()}
<tr><td style="padding:26px 24px 8px 24px;">
 <div style="font-family:${FH};font-size:26px;font-weight:700;color:${DEEP};line-height:1.2;">We need your Ordering Schedule file.</div>
 <div style="font-family:${FB};font-size:16px;color:${BODY};line-height:1.45;padding-top:8px;">Without it we cannot tell you when to order. Send it within <b style="color:${RED};">${CHASE_HOURS} hours</b>: by <b style="color:${RED};">${esc(deadline.text)}</b>.</div>
</td></tr>
<tr><td style="padding:14px 24px 0 24px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
 ${yourBox}
 ${step(1, 'Get the Excel file from your Inventory Manager.',
    `It is the <b>Ordering Schedule</b> for your ship. Inside it says <span style="font-family:${FM};font-size:13px;color:${GINK};">HOTEL BIWEEKLY HOTEL</span>.`)}
 ${step(2, 'Attach the Excel file. Not a photo. Not a PDF.',
    `Name it with your ship: <span style="font-family:${FM};font-size:13px;color:${GINK};white-space:nowrap;">${esc(fileExample)}</span>`)}
 ${step(3, 'Send it to this address. Nothing else needed.',
    `<span style="font-family:${FM};font-size:18px;font-weight:700;color:${DEEP};">${SCHEDULE_INBOX}</span>`)}
 </table>
</td></tr>
<tr><td style="padding:6px 24px 0 24px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td bgcolor="${CLOUD}" style="background:${CLOUD};padding:12px 14px;font-family:${FB};font-size:14px;color:${BODY};line-height:1.5;">
   <b style="color:${DEEP};">Send from your ship&rsquo;s printer mailbox.</b> One file, one email, no text needed. If you already sent it, send it again the right way. Questions: reply to this email.
  </td>
 </tr></table>
</td></tr>
<tr><td style="padding:22px 24px 6px 24px;">
 <div style="font-family:${FH};font-size:12px;font-weight:700;letter-spacing:1.5px;color:${SLATE};">SHIPS WE ARE STILL WAITING FOR &middot; ${list.length}</div>
</td></tr>
<tr><td style="padding:0 24px 24px 24px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};">
 <tr>
  <td bgcolor="${CLOUD}" style="background:${CLOUD};padding:7px 10px;font-family:${FH};font-size:11px;font-weight:700;letter-spacing:1px;color:${SLATE};">SHIP</td>
  <td bgcolor="${CLOUD}" style="background:${CLOUD};padding:7px 10px;font-family:${FH};font-size:11px;font-weight:700;letter-spacing:1px;color:${SLATE};">WHAT HAPPENED</td>
 </tr>
 ${rows}
 </table>
</td></tr>
<tr><td style="padding:0 24px 26px 24px;">
 <div style="font-family:${FB};font-size:14px;color:${BODY};line-height:1.5;">Thank you,<br><b style="color:${DEEP};">${esc(signer)}</b><br><span style="color:${SLATE};">${esc(signerTitle)}</span></div>
</td></tr>
<tr><td bgcolor="${CLOUD}" style="background:${CLOUD};padding:12px 24px;font-family:${FB};font-size:11px;color:${SLATE};line-height:1.5;">Sent by CIMS for ${esc(signerTitle)}. Reply goes to ${esc(signer)}. Files go only to ${SCHEDULE_INBOX}.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
