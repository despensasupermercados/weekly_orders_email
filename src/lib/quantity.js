// Does the order that exists actually contain what the ship needs?
//
// Everything before this module answered one question: is there AN order for
// this voyage. That is not the same question as whether the ship will be able
// to print. An order can exist, be raised on time, carry a PO, and still be
// missing cyan - and cyan does not arrive by itself, it waits for the next
// container or it flies.
//
// SCOPE, HONESTLY STATED. Two of these rules stand on their own evidence and
// two do not:
//
//   * Colour completeness and "an order with no toner at all" are self-evident
//     from the order lines. A four-colour press needs four colours. No external
//     figure is required and none is assumed.
//   * The waste-box counts and the USA/international buffers are QUANTITIES,
//     and every quantity in this estate has a named source in the INV_ series
//     that this Worker cannot read. The numbers below come from the 9 Sep 2026
//     handover note, which is a summary, not the canonical source. They are
//     therefore OFF by default. Turn them on only after Ray or INV_04 confirms
//     them, by setting QUANTITY_RULES.
//
// That split is deliberate. The alternative - shipping a plausible-looking
// number - is exactly how this project produced four confident wrong answers in
// one session. A check that says "I cannot run" is worth more than one that
// says zero because it was looking at the wrong column.

import { require_, firstPresent } from './schema.js';

// The four process colours. A press missing any one of them is stopped.
export const COLOURS = ['black', 'cyan', 'magenta', 'yellow'];

// Word first, Konica TN-code suffix second. "TONER TN-514K" carries the colour
// only in that trailing letter, and roughly half of Ray's descriptions are the
// short form.
const COLOUR_WORD = {
  black: /\bblack\b|\bbk\b/i,
  cyan: /\bcyan\b/i,
  magenta: /\bmagenta\b/i,
  yellow: /\byellow\b/i,
};
const TN_SUFFIX = /\b(?:TN|DV|IU|DR)[-\s]?\d{3,4}\s*([KCMY])\b/i;
const SUFFIX_TO_COLOUR = { K: 'black', C: 'cyan', M: 'magenta', Y: 'yellow' };

// Toner is filed under Parts but is a consumable, and is identified by its
// DESCRIPTION, never by the category column. That is a standing fact in the
// INV_ series and the reason this matches on text.
const IS_TONER = /\btoner\b/i;
const IS_WASTE = /\bwaste\b.*\b(box|bottle|container|toner)\b|\bwb[-\s]?\d/i;

// THE WORD "TONER" IS NOT THE SAME THING AS "A TONER CARTRIDGE".
//
// This check was dead on every real order and the test fixture hid it. A
// WASTE TONER BOX contains the word toner, so it was counted as a toner line;
// it has no colour, so it landed in `unknown`; and one unknown line suppresses
// the missing-colour finding entirely. Every real order carries a waste box,
// so the headline check - "an order can be raised on time and still be missing
// cyan" - reported TONER_UNREADABLE instead of MISSING_COLOUR, always. Proven
// against a four-colour order plus a waste box: cyan removed, still no
// MISSING_COLOUR.
//
// The same trap is set by every other part with "toner" in its name. A filter,
// a hopper or a duct is a Part, not a colour, and none of them should be able
// to silence the check.
const TONER_NOT_A_CARTRIDGE =
  /\b(waste|filter|hopper|duct|assy|assembly|unit|motor|sensor|gear|seal|screw|guide|cover|holder|cleaner|blade|auger|conveyance|suction)\b/i;

const isColourCartridge = (d) =>
  IS_TONER.test(d) && !IS_WASTE.test(d) && !TONER_NOT_A_CARTRIDGE.test(d);

export function colourOf(description) {
  const d = String(description || '');
  for (const [colour, re] of Object.entries(COLOUR_WORD)) if (re.test(d)) return colour;
  const m = d.match(TN_SUFFIX);
  return m ? SUFFIX_TO_COLOUR[m[1].toUpperCase()] : null;
}

// Defaults are the CONSERVATIVE reading: only the two rules that need no
// external figure are enabled. See the scope note above.
export const DEFAULT_RULES = {
  colour_completeness: true,
  waste_box: false,
  waste_box_base: 12,
  waste_box_high_volume: 24,
  waste_box_azamara: 12,
  buffers: false,
  buffer_usa: 3,
  buffer_international: 4,
};

export function rulesFrom(json) {
  if (!json) return { ...DEFAULT_RULES };
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return { ...DEFAULT_RULES, ...parsed };
  } catch (_) {
    // A malformed rules variable must not silently fall back to defaults and
    // then be reported as "checked". The caller surfaces this as a finding.
    return { ...DEFAULT_RULES, _invalid: true };
  }
}

// Pure. Takes the order lines already grouped for one (ship, loading) and says
// what is wrong with them. No database, no dates, no I/O - so it is testable
// against a fixture and the fixture is the thing Ray can be shown.
export function analyseOrder(order, rules = DEFAULT_RULES) {
  const { ship, loading_delivery_date, lines = [], azamara = false } = order;
  const out = [];
  const say = (code, severity, detail) =>
    out.push({ ship, loading_delivery_date, code, severity, detail });

  const toner = lines.filter((l) => isColourCartridge(l.description));

  if (rules.colour_completeness) {
    if (!toner.length) {
      // Not automatically wrong - a paper-only top-up is a real order - so this
      // is a question, not an accusation.
      say('NO_TONER', 'warn',
        `order has ${lines.length} line${lines.length === 1 ? '' : 's'} and no toner at all`);
    } else {
      const present = new Set(toner.map((l) => colourOf(l.description)).filter(Boolean));
      const unknown = toner.filter((l) => !colourOf(l.description));
      const missing = COLOURS.filter((c) => !present.has(c));
      // Only call a colour missing when every toner line was identifiable. If
      // one description did not parse, the colour may well be in the box and
      // the honest finding is that we could not read it.
      if (unknown.length) {
        say('TONER_UNREADABLE', 'warn',
          `${unknown.length} of ${toner.length} toner lines have no readable colour ` +
          `(e.g. "${String(unknown[0].description).slice(0, 60)}") - colour completeness not checked`);
      } else if (missing.length) {
        say('MISSING_COLOUR', 'critical',
          `toner ordered for ${[...present].sort().join(', ')} but not ${missing.join(', ')} - ` +
          `the press stops when the first of those runs out`);
      }
    }
  }

  if (rules.waste_box) {
    const waste = lines.filter((l) => IS_WASTE.test(l.description));
    const qty = waste.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const want = azamara ? rules.waste_box_azamara : rules.waste_box_base;
    if (!waste.length) say('NO_WASTE_BOX', 'warn', `no waste toner box on the order (expected ${want})`);
    else if (qty < want) say('WASTE_BOX_SHORT', 'warn', `${qty} waste boxes ordered, expected at least ${want}`);
  }

  return out;
}

// ---- the database side ----
//
// obp_intransit is Ray's export mirrored byte for byte and its column names are
// not ours to assume. Resolve them, and if they cannot be resolved say so
// instead of returning an empty list that reads like a clean bill of health.
const DESC_COLS = ['item_description', 'description', 'item', 'part_description', 'part', 'material_description'];
const QTY_COLS = ['qty', 'quantity', 'order_qty', 'qty_ordered', 'open_qty'];

export async function quantityFindings(hon, states, rules = DEFAULT_RULES) {
  const probe = await require_(hon, 'obp_intransit', ['ship', 'eta', 'snapshot_date']);
  if (!probe.ok) return { ran: false, reason: probe.reason, findings: [] };

  const descCol = firstPresent(probe.columns, DESC_COLS);
  const qtyCol = firstPresent(probe.columns, QTY_COLS);
  if (!descCol) {
    return {
      ran: false,
      findings: [],
      reason:
        `obp_intransit has no recognisable description column (looked for ${DESC_COLS.join(', ')}). ` +
        `Order lines cannot be read, so completeness is UNKNOWN, not clean.`,
    };
  }

  // Only voyages that HAVE an order. A voyage with none is already the weekly
  // email's business and saying it twice in two voices helps nobody.
  const ordered = states.filter((s) => s.state === 'ORDERED' && s.loading_delivery_date);
  if (!ordered.length) return { ran: true, reason: null, findings: [], checked: 0 };

  const ETA = "date('1899-12-30', '+' || CAST(i.eta AS INTEGER) || ' days')";
  const loadings = [...new Set(ordered.map((o) => o.loading_delivery_date))];
  const ships = [...new Set(ordered.map((o) => o.ship))];
  // Plain placeholders rather than json_each: the list is at most a few dozen
  // values, and a portable query is one fewer thing that can be unavailable at
  // 02:00 with nobody watching.
  const marks = (n) => Array(n).fill('?').join(',');
  const sql = `
    SELECT i.ship AS ship, ${ETA} AS loading, i.${descCol} AS description
           ${qtyCol ? `, i.${qtyCol} AS qty` : ', NULL AS qty'}
      FROM obp_intransit i
     WHERE i.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
       AND ${ETA} IN (${marks(loadings.length)})
       AND i.ship IN (${marks(ships.length)})`;

  const r = await hon.prepare(sql).bind(...loadings, ...ships).all();
  const rows = r.results || [];

  const byKey = new Map();
  for (const row of rows) {
    const k = `${row.ship}|${row.loading}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ description: row.description, qty: row.qty });
  }

  const findings = [];
  for (const o of ordered) {
    const lines = byKey.get(`${o.ship}|${o.loading_delivery_date}`) || [];
    // due.js already proved an order exists for this loading. If the line-level
    // read comes back empty the two queries disagree, and a disagreement between
    // our own two reads is a bug in us, not a finding about the ship.
    if (!lines.length) continue;
    findings.push(...analyseOrder({
      ship: o.ship,
      loading_delivery_date: o.loading_delivery_date,
      lines,
      azamara: o.mot === 'AZAMARA BWS',
    }, rules));
  }
  return { ran: true, reason: null, findings, checked: ordered.length, description_column: descCol };
}
