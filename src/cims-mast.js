// CIMS letterhead — canonical. Local copy per EMAIL-CONVENTION §5.
// Do not import across apps. Copy this file byte-identical into every repo;
// tools/mast-check.sh proves the copies have not drifted.
//
// Derived from cims-travel-console mast(), with three corrections:
//   1. rgba() text colours replaced with solid hex — the Outlook/Word engine
//      drops rgba and can render the subtitle black-on-navy (invisible).
//   2. bgcolor attributes added alongside the CSS — Word honours the attribute.
//   3. webfont declared with a Helvetica/Arial fallback, so Outlook (which
//      never loads webfonts) renders exactly what it renders today.
//
// The 60/40 rule is a two-cell TABLE, never linear-gradient(). Outlook ignores
// CSS gradients and the rule disappears entirely.

export const M = {
  navy: "#1B3A5C",   // top rule, left 60%
  deep: "#142D48",   // brand block fill
  green: "#5FB946",  // top rule right 40%, wordmark underline
  sub: "#95A0AD",    // subtitle — solid equivalent of white @ 55% over deep
};

const FH = "'Outfit',Helvetica,Arial,sans-serif";

// The two rows, for insertion inside an app's existing container <table>.
export const mastRows = () => `
<tr><td style="padding:0;font-size:0;line-height:0;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td width="60%" height="4" bgcolor="${M.navy}" style="background:${M.navy};font-size:0;line-height:0;height:4px;">&nbsp;</td>
  <td width="40%" height="4" bgcolor="${M.green}" style="background:${M.green};font-size:0;line-height:0;height:4px;">&nbsp;</td>
 </tr></table>
</td></tr>
<tr><td bgcolor="${M.deep}" style="background:${M.deep};padding:20px 24px;">
 <div style="font-family:${FH};font-size:20px;font-weight:700;letter-spacing:5px;color:#FFFFFF;line-height:1;">CIMS</div>
 <div style="width:78px;height:2px;background:${M.green};font-size:0;line-height:0;margin:7px 0 5px;">&nbsp;</div>
 <div style="font-family:${FH};font-size:7px;font-weight:600;letter-spacing:2.2px;color:${M.sub};line-height:1;">CRUISE INDUSTRY MANAGED SERVICES</div>
</td></tr>`;

// Standalone, for apps that drop the letterhead in as its own block.
export const mast = () =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${mastRows()}</table>`;
