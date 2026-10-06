import assert from 'node:assert/strict';
import { fleetCoverage } from '../src/lib/coverage.js';
import { renderWeekly } from '../src/lib/email.js';

// Miguel, 21 Sep 2026: "how certain are we we will NOT skip one coz we don't
// have the data". Three silent skips, each one asserted here.
const MAP = 'Vision = vi@x.com; Jewel = jw@x.com; Star = st@x.com';
const today = '2026-09-21';
const ok = (over = {}) => fleetCoverage({
  fleetMap: MAP, checked: ['Vision', 'Jewel', 'Star'],
  checks: [{ name: 'runway', ran: true }, { name: 'ordering schedule', ran: true }],
  unread: [], today, ...over,
});

{ // A healthy run says nothing, and says it about the whole addressed fleet.
  const c = ok();
  assert.equal(c.ok, true);
  assert.equal(c.addressed, 3);
  assert.equal(c.examined, 3);
  assert.deepEqual(c.lines, []);
  assert.equal(c.note, null);
}

{ // 1. UNREADABLE QUANTITIES. Built by runwayDb, dropped by index.js until today.
  const c = ok({ unread: [{ ship: 'Jewel', item: 'TK-8515K' }, { ship: 'Jewel', item: 'TK-8515C' }] });
  assert.equal(c.ok, false, 'a quantity we cannot read is not a clear ship');
  assert.equal(c.unreadItems, 2);
  assert.equal(c.unreadByShip.length, 1);
  assert.match(c.lines.join(' '), /Jewel \(2\)/);
  assert.match(c.lines.join(' '), /NOT measured for running out/);
}

{ // 2. A BROKEN CHECK. Empty findings must never read as a healthy fleet.
  const c = ok({ checks: [{ name: 'runway', ran: false, reason: 'no snapshot for today' }] });
  assert.equal(c.ok, false);
  assert.equal(c.broken.length, 1);
  assert.match(c.lines[0], /runway check did not run — no snapshot for today/);
  assert.match(c.lines[0], /which may not be true/);
}

{ // 3. THE DENOMINATOR. A ship that vanishes is named, not quietly subtracted.
  const c = ok({ checked: ['Vision'] });
  assert.equal(c.ok, false);
  assert.deepEqual(c.unexamined, ['Jewel', 'Star']);
  assert.equal(c.addressed, 3, 'the denominator is the fleet we address');
  assert.equal(c.examined, 1);
  assert.match(c.note, /2 ship\(s\) unexamined \(Jewel, Star\)/);
}

{ // A check reporting ran:true with no findings is genuinely clear.
  const c = ok({ checks: [{ name: 'runway', ran: true, reason: null }] });
  assert.equal(c.ok, true, 'ran with nothing found is good news, not a gap');
}

// ---- rendering: ops sees it, crews never do -------------------------------
const degraded = ok({ checked: ['Vision'], checks: [{ name: 'runway', ran: false, reason: 'no snapshot' }], unread: [{ ship: 'Vision', item: 'TK-8515K' }] });
const base = { gaps: [], runsOut: [], deliveries: [], schedules: [] };

{ // The fleet email states what it could not do, and counts the real fleet.
  const html = renderWeekly([], [], today, { ...base, checked: ['Vision'], coverage: degraded });
  assert.match(html, /COULD NOT CHECK/);
  assert.match(html, /1 of 3 ships ok/, 'denominator is the addressed fleet, not the reached one');
  assert.match(html, /could not be checked/, 'the "nothing due" footer is qualified');
  assert.ok(!/linear-gradient|rgba\(/.test(html), 'Outlook rules hold');
}

{ // A healthy fleet email carries no block and no caveat.
  const html = renderWeekly([], [], today, { ...base, checked: ['Vision', 'Jewel', 'Star'], coverage: ok() });
  assert.ok(!/COULD NOT CHECK/.test(html));
  assert.match(html, /3 of 3 ships ok/);
  assert.match(html, /Ships not listed have nothing due this week\./);
}

{ // THE CREW MUST NEVER SEE IT. due.js:226 - a warning nobody can act on is
  // worse than silence, and a Printer Specialist cannot fix an OBP export.
  const crew = renderWeekly([], [], today, { ...base, checked: ['Vision'], coverage: degraded, audience: 'ship', ship: 'Vision' });
  assert.ok(!/COULD NOT CHECK/.test(crew), 'ops-only block must not reach a ship');
  assert.ok(!/could not be checked|were not examined/.test(crew), 'nor its wording');
}

console.log('ok - coverage: unread quantities, broken checks and unexamined ships are all named, to ops only');

// REVIEW OF 6 Oct 2026: "N OF 48 SHIPS OK" MUST COUNT ADDRESSED SHIPS ONLY.
// `checked` is every name any check examined. The OBP export carries "DIS WHS"
// and "MIAMI WHS" (warehouses) and "Hero" (a 2027 hull), and the gap check
// hands back whatever ship names it saw; none of them is a ship we address, so
// none of them can be "ok". And a troubled ship spelt one way in its finding
// and another in the checked list ("Vision of the Seas" / "Vision") counted
// as both troubled AND clean. Today the data happens to line up (48 par ships,
// 48 addressed, one spelling); the header must not depend on that luck.
{
  const c = fleetCoverage({
    fleetMap: MAP, checked: ['Vision', 'Jewel', 'Star', 'DIS WHS', 'MIAMI WHS', 'Hero'],
    checks: [{ name: 'runway', ran: true }], unread: [], today,
  });
  assert.equal(c.ok, true, 'extra names examined are not a coverage problem');
  assert.equal(c.addressed, 3);
  assert.equal(c.examined, 3, 'examined counts addressed ships, never warehouses');
  assert.deepEqual([...c.examinedShips].sort(), ['Jewel', 'Star', 'Vision'], 'and names them for the header');
  const html = renderWeekly([], [], today, {
    ...base, checked: ['Vision', 'Jewel', 'Star', 'DIS WHS', 'MIAMI WHS', 'Hero'], coverage: c,
    runsOut: [{ ship: 'Vision of the Seas', item: 'TN619K', stockout: '2026-09-30', on_hand: 1, rate: 3, order_due: '2026-09-25' }],
  });
  const strap = html.match(/[\d]+ of [\d]+ ships ok/)?.[0];
  assert.equal(strap, '2 of 3 ships ok', `warehouses are not ships and a troubled ship is not clean under another spelling: ${strap}`);
}
console.log('ok - coverage: the "ships ok" count is over addressed ships only, matched by normalised name');
