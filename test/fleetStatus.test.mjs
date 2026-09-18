// node test/fleetStatus.test.mjs
// Two of Miguel's ordering decisions, 11 Sep 2026, pinned so they survive.

import { inService, isAzamara, byFleetOrder, NOT_IN_SERVICE } from '../src/lib/fleetStatus.js';
import assert from 'node:assert';

// LEGEND IS STILL BEING BUILT. No crew aboard until April 2027, so nobody can
// act on a warning - but it carries 1,527 seeded inventory rows, which read as
// a ship running out of paper at 48 a month. Putting that at the top of a crew
// email teaches the reader that the top of the email is wrong.
// Legend IS in service (Brain correction of 8 Sep 2026; schedule sent by its
// printer 12 Sep; consumption and in-transit lines in D1). It was wrongly
// listed as a 2027 newbuild from 11 to 18 Sep and got no Monday email.
assert.equal(inService('Legend', '2026-09-21'), true, 'Legend sails and gets its email');
assert.equal(inService('Legend', '2026-09-11'), true);
// The mechanism stays: a hull listed with a date is silent until that date.
NOT_IN_SERVICE.Hero = '2027-06-01';
assert.equal(inService('Hero', '2027-05-31'), false, 'the day before is still too early');
assert.equal(inService('Hero', '2027-06-01'), true, 'dated, not deleted - it returns on its own');
delete NOT_IN_SERVICE.Hero;
assert.equal(inService('Allure', '2026-09-11'), true, 'every other ship is unaffected');
assert.equal(NOT_IN_SERVICE.Legend, undefined, 'Legend must never be listed as not in service again');

// AZAMARA GOES LAST. They run on a different schedule - no ordering schedule of
// their own, a BWS delivery date instead of a due date - so mixing them in
// makes the reader check which rules apply on every line.
for (const s of ['Journey', 'Onward', 'Pursuit', 'Quest']) assert.ok(isAzamara(s), s);
for (const s of ['Allure', 'Apex', 'Anthem', 'Quantum']) assert.ok(!isAzamara(s), s);

const sorted = ['Quest', 'Allure', 'Journey', 'Anthem', 'Onward', 'Apex'].sort(byFleetOrder);
assert.deepEqual(sorted, ['Allure', 'Anthem', 'Apex', 'Journey', 'Onward', 'Quest'],
  'Royal and Celebrity alphabetically, then the four Azamara hulls');
assert.deepEqual(['Onward', 'Journey'].sort(byFleetOrder), ['Journey', 'Onward'],
  'and alphabetical within the Azamara group too');

// A comparator that never returns 0 is inconsistent, and this project has
// already shipped one of those.
assert.equal(byFleetOrder('Apex', 'Apex'), 0);
assert.equal(byFleetOrder('Quest', 'Quest'), 0);

console.log('ok - fleet order: Azamara last; a dated hull is silent until its crew boards; Legend is in service');
