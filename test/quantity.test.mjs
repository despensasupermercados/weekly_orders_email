// node test/quantity.test.mjs
// "An order can exist and still be missing cyan." Everything here pins that
// sentence, plus the rule that an unreadable description produces a QUESTION
// and never an accusation.

import { analyseOrder, colourOf, DEFAULT_RULES, rulesFrom, COLOURS } from '../src/lib/quantity.js';
import assert from 'node:assert';

// Colour is carried either in a word or in the trailing letter of the part
// code. Roughly half of Ray's descriptions are the short form.
assert.equal(colourOf('TONER CARTRIDGE CYAN TN-514C'), 'cyan');
assert.equal(colourOf('TONER TN-514M'), 'magenta');
assert.equal(colourOf('TONER TN 626 Y'), 'yellow');
assert.equal(colourOf('TONER TN-514K'), 'black');
assert.equal(colourOf('WASTE TONER BOX WB-505'), null, 'a waste box has no colour');

const toner = (c) => ({ description: `TONER CARTRIDGE TN-514${c}`, qty: 4 });
const at = (findings, code) => findings.find((f) => f.code === code);

// THE HEADLINE CASE. Three colours ordered, cyan absent. The order exists, has
// a PO, was raised on time, and the press still stops.
const missingCyan = analyseOrder({
  ship: 'Apex',
  loading_delivery_date: '2026-10-09',
  lines: [toner('K'), toner('M'), toner('Y'), { description: 'PAPER A4 80GSM', qty: 40 }],
});
const mc = at(missingCyan, 'MISSING_COLOUR');
assert.ok(mc, 'a missing colour must be found');
assert.equal(mc.severity, 'critical');
assert.ok(mc.detail.includes('cyan'), 'the finding must name the colour that is missing');

// All four present is silence. A check that fires on a good order is filtered
// within a month and then the real one is invisible too.
assert.equal(
  analyseOrder({ ship: 'Apex', loading_delivery_date: '2026-10-09', lines: COLOURS.map((_, i) => toner('KCMY'[i])) })
    .length, 0, 'a complete order must produce no findings at all');

// THE BUG THAT MADE THIS CHECK DEAD ON EVERY REAL ORDER.
// A WASTE TONER BOX contains the word "toner", so it counted as a toner line;
// it has no colour, so it landed in `unknown`; and one unknown line suppresses
// the missing-colour finding. Every real order carries a waste box, so the
// headline check reported TONER_UNREADABLE instead of MISSING_COLOUR, always.
// The original fixture used four clean cartridges and nothing else, which is
// not what an order looks like.
const realOrder = [toner('K'), toner('C'), toner('M'), toner('Y'),
  { description: 'WASTE TONER BOX WB-505', qty: 12 },
  { description: 'TONER SUCTION FILTER', qty: 1 }];
assert.equal(analyseOrder({ ship: 'Apex', loading_delivery_date: '2026-10-09', lines: realOrder }).length, 0,
  'a complete order must stay silent even with a waste box and a toner filter on it');
const realNoCyan = realOrder.filter((l) => !l.description.includes('514C'));
assert.equal(at(analyseOrder({ ship: 'Apex', loading_delivery_date: '2026-10-09', lines: realNoCyan }), 'MISSING_COLOUR').severity,
  'critical', 'a missing cyan must survive the waste box that used to mask it');

// An unreadable description means WE could not tell, not that the ship failed.
// Calling a colour missing on the strength of a description we did not parse is
// how a check loses its authority in one email. This must be a real CARTRIDGE
// whose colour will not parse, not a part that merely has "toner" in its name.
const unreadable = analyseOrder({
  ship: 'Summit',
  loading_delivery_date: '2026-10-09',
  lines: [toner('K'), toner('C'), toner('M'), { description: 'TONER CARTRIDGE 4062-3001', qty: 1 }],
});
assert.ok(at(unreadable, 'TONER_UNREADABLE'), 'an unparseable toner line must be reported as unreadable');
assert.ok(!at(unreadable, 'MISSING_COLOUR'),
  'yellow must NOT be called missing while a toner line is still unread');

// A PAPER-ONLY ORDER IS SILENT NOW. Measured 21 Sep 2026: this fired 15 times
// a night, on every paper-only top-up, and the only way to know whether it
// mattered was to ask whether the ship's toner lasts until the next container
// - which runwayDb already computes and already tells the ship. A question
// nobody can act on, asked nightly, is what buried three real criticals under
// 158 warnings.
const paperOnly = analyseOrder({
  ship: 'Journey', loading_delivery_date: '2026-10-07',
  lines: [{ description: 'PAPER A4 80GSM', qty: 80 }],
});
assert.ok(!at(paperOnly, 'NO_TONER'), 'a paper-only order is not a finding');

// THE WASTE-BOX RULE IS OFF, AND NOT BECAUSE THE NUMBER IS UNSOURCED.
// An earlier version of this file said it was. That was wrong: Ray confirmed 12
// base and 24 on high volume, and INV_06 says exactly 12. It is off because 12
// is a PAR - what should be ABOARD - while this check reads an ORDER LINE.
// Comparing an order quantity to a par level is a unit error that would fire on
// every correctly sized top-up.
assert.equal(DEFAULT_RULES.waste_box, false);
assert.equal(DEFAULT_RULES.buffers, false);
assert.equal(DEFAULT_RULES.colour_completeness, true, 'four colours needs no external figure');

const noWaste = analyseOrder(
  { ship: 'Apex', loading_delivery_date: '2026-10-09', lines: COLOURS.map((_, i) => toner('KCMY'[i])) },
  rulesFrom('{"waste_box": true}'));
assert.ok(at(noWaste, 'NO_WASTE_BOX'), 'once enabled, a missing waste box is reported');

// A malformed rules variable must not fall through to defaults and then be
// reported as "checked".
assert.equal(rulesFrom('{not json')._invalid, true);

console.log('ok - completeness: a missing colour is critical, an unreadable line is a question,');
console.log('     and a waste box no longer masks the colour it was hiding');

// ON-HAND CHANGES THE VERDICT. Explorer, 10 Sep 2026: flagged critical for
// black with 14 black on board. With an on-hand read, a colour the ship still
// holds is a warn that states the figure; a colour it holds none of stays
// critical. Without a read, unchanged: critical.
{
  const lines = [
    { description: 'TN619C CYAN TONER', qty: 4 }, { description: 'TN619M MAGENTA TONER', qty: 4 },
    { description: 'TN619Y YELLOW TONER', qty: 4 },
  ];
  const withStock = analyseOrder({ ship: 'Explorer', loading_delivery_date: '2026-10-10', lines,
    on_hand: { black: 14, cyan: 12, magenta: 13, yellow: 13 } });
  // A COLOUR THE SHIP ALREADY HOLDS IS NOT AN INCOMPLETE ORDER. This was 47
  // warnings a night - the largest single source of noise in the digest - and
  // eight of eight spot-checks were false. Nobody reorders what they have, and
  // whether that stock lasts is runwayDb's question, not this rule's.
  assert.equal(withStock.length, 0, 'a colour held aboard raises nothing here');
  const bare = analyseOrder({ ship: 'Explorer', loading_delivery_date: '2026-10-10', lines,
    on_hand: { black: 0, cyan: 12, magenta: 13, yellow: 13 } });
  assert.equal(bare[0].severity, 'critical');
  assert.match(bare[0].detail, /none on board/);
  const unknown = analyseOrder({ ship: 'Explorer', loading_delivery_date: '2026-10-10', lines });
  assert.equal(unknown[0].severity, 'critical');
  console.log('ok - colour completeness: a colour held aboard is silent, none aboard is critical, unread is critical');
}


// REVIEW OF 17 Sep 2026: an on-hand that was not read is not "none on board".
{
  const r = analyseOrder({ ship: 'Apex', loading_delivery_date: '2026-10-09', lines: [toner('K'), toner('M'), toner('Y')], on_hand: { magenta: 2 } });
  const mc = r.findings ? r.findings.filter((f) => f.code === 'MISSING_COLOUR') : r.filter((f) => f.code === 'MISSING_COLOUR');
  assert.ok(mc.some((f) => f.severity === 'critical' && /on-hand not read for cyan/.test(f.detail)), `unread is named as unread: ${JSON.stringify(mc)}`);
  assert.ok(!mc.some((f) => /none on board/.test(f.detail)), 'and never called empty');
  const z = analyseOrder({ ship: 'Apex', loading_delivery_date: '2026-10-09', lines: [toner('K'), toner('M'), toner('Y')], on_hand: { cyan: 0 } });
  const mz = z.findings ? z.findings.filter((f) => f.code === 'MISSING_COLOUR') : z.filter((f) => f.code === 'MISSING_COLOUR');
  assert.ok(mz.some((f) => /none on board/.test(f.detail)), 'a real zero is still none on board');
  console.log('ok - quantity: unread on-hand is said to be unread, a real zero is empty');
}
