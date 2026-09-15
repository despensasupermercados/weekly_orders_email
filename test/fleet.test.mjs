// node test/fleet.test.mjs
// Per-ship addressing. The rule being guarded is that an address is NEVER
// derived - only ever read from FLEET_MAP - because a guessed mailbox that
// happens to exist delivers another company's operational data to a stranger.

import { normShip, parseFleetMap, planFleetSend, isEmail, maskEmail } from '../src/lib/fleet.js';
import assert from 'node:assert';

// The three sources spell the same vessel three ways. If the join fails the
// ship is unaddressable and nobody is told, which is the silent failure mode.
assert.equal(normShip('Allure of the Seas'), normShip('Allure'));
assert.equal(normShip('Celebrity Apex'), normShip('Apex'));
assert.equal(normShip('  ODYSSEY OF THE SEAS '), 'odyssey');
assert.notEqual(normShip('Anthem'), normShip('Ovation'), 'distinct ships must stay distinct');

assert.ok(isEmail('a.b@dg3.com'));
assert.ok(!isEmail('not-an-address'));
assert.ok(!isEmail('two@a.com,three@b.com'), 'a comma-joined pair is not one address');

// Comments and newlines are allowed so the variable can carry a note about who
// maintains it. Malformed lines are collected, never silently dropped.
const { map, bad } = parseFleetMap(`
  # maintained by Ray
  Allure of the Seas = allure.print@rccl.com
  Celebrity Apex     = apex.print@celebrity.com, apex.hotel@celebrity.com
  Broken Ship        =
  Nonsense line without an equals
`);
assert.equal(map.size, 2);
assert.equal(map.get(normShip('Apex')).to.length, 2);
assert.equal(bad.length, 2, 'a ship with no address and a line with no = are both malformed');

// THE RULE. A ship with no entry is reported as unaddressable and its rows are
// kept. It is never guessed at, and never quietly dropped.
const rows = [
  { ship: 'Allure', due_date: '2026-09-14', state: 'DUE NOW' },
  { ship: 'Allure', due_date: '2026-09-11', state: 'MISSED' },
  { ship: 'Quantum of the Seas', due_date: '2026-09-12', state: 'DUE NOW' },
];
const plan = planFleetSend(rows, 'Allure of the Seas = allure.print@rccl.com');

assert.equal(plan.sendable.length, 1);
assert.equal(plan.sendable[0].to[0], 'allure.print@rccl.com');
assert.equal(plan.sendable[0].rows.length, 2, 'both Allure rows go in one email, not two');
assert.equal(plan.sendable[0].rows[0].due_date, '2026-09-11', 'deadline order, never alphabetical');

assert.equal(plan.unmapped.length, 1, 'Quantum has no entry');
assert.equal(plan.unmapped[0].ship, 'Quantum of the Seas');
assert.equal(plan.unmapped[0].rows.length, 1, "an unaddressable ship's rows are kept, not discarded");

// No map at all must not silently mail everybody, and must not throw either.
const none = planFleetSend(rows, '');
assert.equal(none.sendable.length, 0);
assert.equal(none.unmapped.length, 2);

// One ship's email must never carry another ship's rows.
for (const g of plan.sendable) {
  assert.ok(g.rows.every((r) => normShip(r.ship) === normShip(g.ship)),
    'a ship email must contain only that ship');
}

// MASKING. /fleet is served over a public, unauthenticated URL - and Workers
// Builds publishes a preview URL for every commit - so the default response
// must not be a harvestable list of every printer in the fleet tied to a ship.
// It must still be useful for the job it exists to do: spotting a wrong domain.
assert.equal(maskEmail('allure.print@rccl.com'), 'al***t@rccl.com');
assert.equal(maskEmail('ab@dg3.com'), 'a***@dg3.com', 'a short local part must not be reconstructable');
assert.equal(maskEmail('not-an-address'), '***');
assert.equal(maskEmail(''), '***');
for (const a of ['allure.print@rccl.com', 'apex.hotel@celebrity.com']) {
  const m = maskEmail(a);
  assert.ok(m.endsWith(a.slice(a.lastIndexOf('@'))), 'the domain stays visible - a wrong domain is the common error');
  assert.ok(!m.includes(a.slice(0, a.lastIndexOf('@'))), 'the local part must never survive whole');
}

console.log('ok - fleet addressing: names reconcile, unmapped ships are kept and reported,');
console.log('     and no address is ever derived from a ship name');

// A SHIP WHOSE ONLY FINDING IS A DELIVERY GAP MUST STILL BE PLANNED. It has no
// voyage rows, because it has no ordering schedule - which is precisely the
// state the 25 unscheduled ships are in. Planning only from `rows` left them
// out of the send entirely, and a ship that is never mailed cannot tell the
// difference between "you are fine" and "we cannot see you".
const gapOnly = planFleetSend(
  [{ ship: 'Allure', due_date: '2026-09-14', state: 'DUE NOW' }],
  'Allure of the Seas = allure.print@rccl.com\nAnthem of the Seas = anthem.print@rccl.com',
  [{ ship: 'Anthem', gap_days: 51, after_delivery: '2026-09-30', next_delivery: '2026-11-20' }]);
const anthemGroup = gapOnly.sendable.find((g) => g.ship === 'Anthem');
assert.ok(anthemGroup, 'a gap-only ship must be planned for a send');
assert.equal(anthemGroup.rows.length, 0, 'it carries no voyage rows, and that is expected');
assert.equal(gapOnly.sendable.length, 2, 'the ship with real rows is still planned too');

// An unmapped gap-only ship is reported, never silently dropped.
const gapUnmapped = planFleetSend([], '', [{ ship: 'Anthem', gap_days: 51 }]);
assert.equal(gapUnmapped.unmapped.length, 1, 'a gap-only ship with no address must be reported');
console.log('ok - fleet: a ship whose only finding is a delivery gap is still planned and reported');

// THE SAME HOLE, ONE ARGUMENT OVER. planFleetSend took `gaps` but not
// `runsOut`, so a ship whose only finding was "you run out of magenta before
// your next container" never reached the send list. On 12 Sep that was Quest,
// with eleven such items and no due date and no gap - the loudest ship in the
// fleet email, and the planner could not see it.
const dryOnly = planFleetSend(
  [],
  'Azamara Quest = quest.print@azamara.com',
  [],
  [{ ship: 'Quest', item: 'TN619M MAGENTA TONER', stockout: '2026-10-10' },
   { ship: 'Quest', item: 'TN324C CYAN TONER', stockout: '2026-10-13' }]);
const questGroup = dryOnly.sendable.find((g) => g.ship === 'Quest');
assert.ok(questGroup, 'a stockout-only ship must be planned for a send');
assert.equal(questGroup.rows.length, 0, 'it carries no voyage rows, and that is expected');
assert.deepEqual(questGroup.to, ['quest.print@azamara.com']);
assert.equal(dryOnly.sendable.length, 1, 'two findings on one ship are one email, not two');

// And unaddressable is reported here too, for the same reason as the gaps.
const dryUnmapped = planFleetSend([], '', [], [{ ship: 'Quest', item: 'x' }]);
assert.equal(dryUnmapped.unmapped.length, 1, 'a stockout-only ship with no address must be reported');
console.log('ok - fleet: a ship whose only finding is a stockout is planned, addressed and reported');
