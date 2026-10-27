// THE ORDERING RULES, PUBLISHED FOR EVERY APP THAT NEEDS THEM.
//
// Miguel, 16 Oct 2026, on the rules Ray settled on 15 Oct: they "should be
// cross pollinated to the Brain and across the apps that use it .. coz is very
// important". HON (cims-hon) sizes the same toner and plans on the same usage,
// and the Brain answers questions about both. A second copy of the port lists
// in another repo would be a second definition, and the two would drift: the
// INV_ series' third law is one definition per concept. So the definition
// stays here, in the code the Monday email runs, and this module writes it to
// a table in the shared D1 database every night. Other apps READ
// weekly_ordering_rules; they never keep their own list.
//
// Every value is taken from the functions and constants the email uses, not
// typed a second time, so the table cannot say something the code does not do.
//
// The table is this Worker's own. Each night every row is written with that
// night's date, and only after every write succeeded are rows from an earlier
// night removed. The table is never empty between the two steps and never
// keeps a rule the code no longer has.

import {
  tonerSpare, deliveryClass, MONTHLY_PORTS, LONG_HAUL_PORTS,
  PAPER_PALLET, RADIANT_MIN, WASTE_BOX_ORDER, FLOOR_MODEL_MONTHS,
} from './runway.js';

export const RULES_TABLE = 'weekly_ordering_rules';

const DDL = `CREATE TABLE IF NOT EXISTS ${RULES_TABLE} (
  rule TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
  published_at TEXT NOT NULL, PRIMARY KEY (rule, key))`;

// One row per rule and key. `value` is text so one table holds numbers, words
// and port classes; `source` is who said it and when, in their words where
// that fits.
export function orderingRules() {
  const spare = (o) => String(tonerSpare(o).spare);
  const rows = [
    ['meta', 'read_me', 'Published nightly by weekly_orders_email from the code the Monday email runs. Read it; do not copy it. docs/RAY-LOGIC.md has every rule with its source.', 'Miguel 16 Oct 2026: cross-pollinate to the Brain and every app that uses it'],
    ['meta', 'port_key', 'compare ports on uppercase letters only: "VENICE (RAVENNA)" -> VENICERAVENNA, "Port Everglades" -> PORTEVERGLADES', 'runway.js portKey'],

    ['usage', 'plan_on', 'last_month', 'Ray 12 Oct 2026: "the usage used was from last month"; 15 Oct 2026, for HON: "using the last month number only and guide the adjustments for the future based on that". Paper, radiant and print-shop toner; floor-model toner see floor_model_plan_on'],
    ['usage', 'floor_model_plan_on', 'six_month_average', 'Ray 22 Oct 2026, asked whether floor-model toner and waste bottles should plan on the 6-month average while paper and C4070 toner stay on last month: "yes. six month average would work better for the floor models toners."'],
    ['usage', 'floor_model_items', 'MFD toner TN324, TN514, TNP48, TNP75, TNP79, TN-328; MFD waste WX-103, WB-P05, waste toner bottles, "WASTE TONER BOX" without (DG3). Not the C4070 waste box, not TN619/TN634', 'runway.js isFloorModel'],
    ['usage', 'floor_model_months', String(FLOOR_MODEL_MONTHS), 'Ray 22 Oct 2026'],
    ['usage', 'floor_model_formula', `(count at the end of the month before the ${FLOOR_MODEL_MONTHS} + every receipt in them - count at the end of last month) / ${FLOOR_MODEL_MONTHS}, from consumption_snapshot. All ${FLOOR_MODEL_MONTHS + 1} month-end counts required, and the result must be above 0; otherwise the item plans on last month`, 'runwayDb.js; counts at both ends cancel a receipt booked in one month and shelved the next'],
    ['usage', 'zero_month', 'trailing_average', 'Ray 13 Oct 2026 (Q3, Quest WX-103 2, 2, then 0): "correct"'],
    ['usage', 'average_role', 'shown beside last month as a view for dry dock and quiet months; not a floor', 'Ray 15 Oct 2026: "the average should be viewed more for dry dock or quite months as the usage can pickup at any time"'],
    ['usage', 'last_month_source', 'OBP Consumption Statistic (weekly_obp_consumption) where Ray\'s export has the month, else month-open + receipts - next month-open', 'Ray 14 Oct 2026: OBP usage excludes transfers out ("10 cases transferred to Legend")'],
    ['usage', 'retired', 'greater of last month and the 3-month average', 'HON spec recJFeQFxD78KCbaX, retired by Ray 15 Oct 2026'],

    ['toner_spare', 'items', 'print-shop toner TN619 C/M/Y and TN634 K (C4070, C4080)', 'Ray 1 Sep 2026 Q20'],
    ['toner_spare', 'monthly', spare({ brand: 'Royal', port: 'MIAMI', nextPort: 'MIAMI' }), 'Ray 15 Oct 2026: "USA ships have a 3+ rule"; 7 Sep: Canada and the Caribbean islands are delivered within the month'],
    ['toner_spare', 'long-haul', spare({ brand: 'Royal', port: 'BARCELONA', nextPort: 'BARCELONA' }), 'Ray 15 Oct 2026: "international ships have a 4+ rule"'],
    ['toner_spare', 'leaving_usa', spare({ brand: 'Royal', port: 'PORT EVERGLADES', nextPort: 'CIVITAVECCHIA' }), 'Sep spec recJFeQFxD78KCbaX: "The last US order before the ship goes international takes +4"; Ray 15 Oct: "international orders ... already has to have the 4+ rule"'],
    ['toner_spare', 'returning_usa', spare({ brand: 'Royal', port: 'PORT EVERGLADES', nextPort: 'MIAMI' }), 'Ray 15 Oct 2026: "the 3+ rule will come into play when they do their first order here, allowing them to adjust to new consumption"'],
    ['toner_spare', 'azamara', spare({ brand: 'Azamara', port: 'Singapore', nextPort: 'Busan' }), 'Sep spec recJFeQFxD78KCbaX: "+3 Azamara (exception cruise line, flat)"; not re-confirmed by Ray on 15 Oct; ask only if an Azamara toner quantity is disputed'],
    ['toner_spare', 'unclassified_port', spare({ brand: 'Royal', port: 'NOT A LISTED PORT', nextPort: 'MIAMI' }), 'the floor; the email line names the port as not on file so a person adds it'],
    ['toner_spare', 'which_order', 'long-haul spare when the order loads at a long-haul port OR the ship\'s next loading does; otherwise the monthly spare', 'Sep spec + Ray 15 Oct 2026; runway.js tonerSpare'],

    ['paper', 'royal_celebrity', String(PAPER_PALLET), 'Ray 1 Sep 2026 Q19: "always ordered in a pallet of 40 cases"'],
    ['paper', 'azamara', 'strict consumption, no pallet', 'Ray 1 Sep 2026 Q19: "based on strict consumption due to space"'],
    ['radiant_white', 'minimum', String(RADIANT_MIN), 'Ray 1 Sep Q20 / 4 Sep Q8: "minimum of 10 cases"'],
    ['waste_box_c4070', 'order', String(WASTE_BOX_ORDER), 'Ray 4 Sep 2026 Q7: "the exact order is 12 pieces per ship from all brands"; round 8: "12 pieces per order no exceptions"; 27 Oct 2026: "the 12 piece rule" - an order quantity, not a par; ordered when the shelf runs dry before the landing after the open order'],
    ['order_timing', 'next_order', 'when the shelf lasts past the landing AFTER the open order, the item is that later order\'s business, whether or not a delivery is already coming', 'Ray 13 Oct 2026 (paper rows struck); 27 Oct 2026, Radiance paper and Star waste box: "Vessel has enough ... for November but needs to put order in December"'],
    ['mfd_toner', 'rule', 'top up to the OBP par', 'Ray 4 Sep 2026 Q1: "we follow this par level and replenish only as needed"'],
  ];
  for (const k of [...MONTHLY_PORTS].sort()) rows.push(['port_class', k, deliveryClass(k), 'delivered within the month (Ray 7 Sep, 15 Oct 2026)']);
  for (const k of [...LONG_HAUL_PORTS].sort()) rows.push(['port_class', k, deliveryClass(k), 'long-haul (Ray 15 Oct 2026)']);
  return rows.map(([rule, key, value, source]) => ({ rule, key, value, source }));
}

const changes = (r) => Number((r && r.meta && r.meta.changes) ?? (r && r.changes) ?? 0);

export async function publishOrderingRules(hon, today) {
  await hon.prepare(DDL).run();
  const rows = orderingRules();
  const stmts = rows.map((r) => hon.prepare(
    `INSERT OR REPLACE INTO ${RULES_TABLE} (rule, key, value, source, published_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(r.rule, r.key, r.value, r.source, today));
  if (typeof hon.batch === 'function') {
    for (let i = 0; i < stmts.length; i += 50) await hon.batch(stmts.slice(i, i + 50));
  } else {
    for (const st of stmts) await st.run();
  }
  // Reached only when every write above succeeded.
  const removed = changes(await hon.prepare(`DELETE FROM ${RULES_TABLE} WHERE published_at <> ?`).bind(today).run());
  return { written: rows.length, removed };
}
