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

// An unreadable description means WE could not tell, not that the ship failed.
// Calling a colour missing on the strength of a description we did not parse is
// how a check loses its authority in one email.
const unreadable = analyseOrder({
  ship: 'Summit',
  loading_delivery_date: '2026-10-09',
  lines: [toner('K'), toner('C'), toner('M'), { description: 'TONER ASSY SPARE 4062-3001', qty: 1 }],
});
assert.ok(at(unreadable, 'TONER_UNREADABLE'), 'an unparseable toner line must be reported as unreadable');
assert.ok(!at(unreadable, 'MISSING_COLOUR'),
  'yellow must NOT be called missing while a toner line is still unread');

// An order with no toner is a question, not a fault: a paper-only top-up is a
// real thing.
const paperOnly = analyseOrder({
  ship: 'Journey', loading_delivery_date: '2026-10-07',
  lines: [{ description: 'PAPER A4 80GSM', qty: 80 }],
});
assert.equal(at(paperOnly, 'NO_TONER').severity, 'warn');

// QUANTITY RULES ARE OFF BY DEFAULT. Waste-box counts come from a handover
// summary, not from a named source, and this estate's first law is that no
// number is invented. They stay off until Ray or INV_04 confirms them.
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
console.log('     and no quantity rule runs on a number without a named source');
