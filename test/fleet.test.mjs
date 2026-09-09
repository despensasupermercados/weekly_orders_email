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
