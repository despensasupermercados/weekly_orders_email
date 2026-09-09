// The night agent's digest. ENGINEERING ONLY - goes to Miguel, never to Ray and
// never to a ship. Stale feeds, format drift, rows repaired: Ray is the person
// the fleet email is signed by, and sending him ops noise is how a useful alert
// becomes something he filters.
//
// Sent only when there is something to say. A nightly mail that always arrives
// gets filtered too, and then the one that matters is invisible.

const NAVY = '#1B3A5C', DEEP = '#142D48', GREEN = '#5FB946';
const SLATE = '#6B7280', CLOUD = '#F4F5F7', BORDER = '#E5E7EB', BODY = '#374151';
const RED = '#8F231A', RED_BG = '#FBE7E4', AMBER = '#8A5B00', AMBER_BG = '#FBF0D8';
const OK = '#2F6B26', OK_BG = '#E7F4E1';
const FH = "'Outfit',Helvetica,Arial,sans-serif";
const FB = "'DM Sans',Helvetica,Arial,sans-serif";

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CHECK_LABEL = {
  feed: 'OBP feed',
  eta_format: 'Export format',
  scope: 'Out-of-scope data',
  orphan_rows: 'Failed ingest swap',
  duplicates: 'Duplicate voyages',
  coverage: 'Schedule coverage',
  schedule_expired: 'Schedule expired',
  schedule_expiring: 'Schedule running out',
  send_failed: 'Weekly email failed',
  ingest_refused: 'Ingest refused a file',
};

function block(title, colour, bg, items) {
  if (!items.length) return '';
  const rows = items.map((t, i) => `
    <tr><td bgcolor="${i % 2 ? '#FAFBFC' : '#FFFFFF'}" style="background:${i % 2 ? '#FAFBFC' : '#FFFFFF'};border-left:4px solid ${colour};padding:10px 13px;border-bottom:1px solid ${BORDER};font-family:${FB};font-size:13px;line-height:1.55;color:${BODY};">${t}</td></tr>`).join('');
  return `
  <tr><td style="padding:18px 26px 8px;">
    <span style="display:inline-block;background:${bg};color:${colour};font-family:${FB};font-size:11px;font-weight:700;letter-spacing:.8px;padding:4px 10px;">${title} &middot; ${items.length}</span>
  </td></tr>
  <tr><td style="padding:0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>`;
}

export function renderWatchdog(report) {
  const crit = report.findings.filter((f) => f.severity === 'critical')
    .map((f) => `<strong>${esc(CHECK_LABEL[f.check] || f.check)}</strong> &mdash; ${esc(f.detail)}`);
  const warn = report.findings.filter((f) => f.severity === 'warn')
    .map((f) => `<strong>${esc(CHECK_LABEL[f.check] || f.check)}</strong> &mdash; ${esc(f.detail)}`);
  const fixed = report.repairs.map(esc);

  const headline = crit.length
    ? `${crit.length} thing${crit.length === 1 ? '' : 's'} need${crit.length === 1 ? 's' : ''} a human`
    : warn.length ? `${warn.length} warning${warn.length === 1 ? '' : 's'}`
    : `${fixed.length} repair${fixed.length === 1 ? '' : 's'} made overnight`;
  const tone = crit.length ? RED : warn.length ? AMBER : OK;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Night check</title></head>
<body style="margin:0;padding:0;background:${CLOUD};" bgcolor="${CLOUD}">
<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;">${esc(headline)}</div>
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

<tr><td style="padding:26px 26px 4px;">
<div style="font-family:${FH};font-size:21px;font-weight:600;color:${NAVY};line-height:1.25;">Night check &mdash; orders watchdog</div>
<div style="font-family:${FB};font-size:12px;color:${SLATE};padding-top:6px;">${esc(report.today)} &middot; <span style="color:${tone};font-weight:600;">${esc(headline)}</span> &middot; ${report.counts.ships_covered} of ${report.counts.fleet || '?'} ships have a schedule loaded</div>
</td></tr>

${block('NEEDS A HUMAN', RED, RED_BG, crit)}
${block('WORTH KNOWING', AMBER, AMBER_BG, warn)}
${block('REPAIRED OVERNIGHT', OK, OK_BG, fixed)}

<tr><td style="padding:20px 26px 28px;"><div style="border-top:1px solid ${BORDER};padding-top:13px;font-family:${FB};font-size:11px;line-height:1.65;color:#9CA3AF;">
This runs every night and only writes when it finds something. Repairs are deletes of rows that should not exist &mdash; out-of-scope supply streams, orphaned rows from a failed ingest, duplicates &mdash; and only of rows this Worker itself wrote. It never invents or rewrites a value, never touches the OBP mirror tables, and never deletes another app's rows. If this email stops arriving entirely, that is not good news: check the Worker's cron.
</div></td></tr>

</table></td></tr></table></body></html>`;
}
