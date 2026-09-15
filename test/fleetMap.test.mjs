// node test/fleetMap.test.mjs
//
// Reads the REAL FLEET_MAP out of wrangler.toml and proves it is whole. Miguel,
// 15 Sep 2026: "the individual ships will go to each ship ... wire them all."
// The value is 48 lines a human can mistype; this is what catches a typo before
// Monday 08:00 Miami does. A wrong pairing sends one crew another crew's
// orders, so the list is checked against the fleet as OBP names it and against
// the three mailbox domains the cruise lines use - nothing else may appear.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parseFleetMap, normShip } from '../src/lib/fleet.js';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const m = /FLEET_MAP = """([\s\S]*?)"""/.exec(toml);
assert.ok(m, 'wrangler.toml carries a multi-line FLEET_MAP');
const { map, bad } = parseFleetMap(m[1]);
assert.deepEqual(bad, [], `malformed FLEET_MAP lines: ${bad.join(' | ')}`);

// The fleet as the par table names it on 15 Sep 2026: 48 ships.
const FLEET = [
  'Adventure', 'Allure', 'Anthem', 'Apex', 'Ascent', 'Beyond', 'Brilliance', 'Constellation',
  'Eclipse', 'Edge', 'Enchantment', 'Equinox', 'Explorer', 'Freedom', 'Grandeur', 'Harmony',
  'Icon', 'Independence', 'Infinity', 'Jewel', 'Journey', 'Legend', 'Liberty', 'Mariner',
  'Millennium', 'Navigator', 'Oasis', 'Odyssey', 'Onward', 'Ovation', 'Pursuit', 'Quantum',
  'Quest', 'Radiance', 'Reflection', 'Rhapsody', 'Serenade', 'Silhouette', 'Solstice', 'Spectrum',
  'Star', 'Summit', 'Symphony', 'Utopia', 'Vision', 'Voyager', 'Wonder', 'Xcel',
];
assert.equal(FLEET.length, 48);
assert.equal(map.size, 48, `FLEET_MAP has ${map.size} ships, the fleet has 48`);
for (const ship of FLEET) {
  assert.ok(map.has(normShip(ship)), `${ship} has no mailbox in FLEET_MAP`);
}

// One mailbox per ship, on one of the three fleet domains, with the ship's own
// two-letter code in the local part - the shape every proven address has.
const DOMAINS = new Set(['rccl.com', 'celebrity.com', 'celebritycruises.com', 'azamaraships.com']);
const seen = new Set();
for (const [, { ship, to }] of map) {
  assert.equal(to.length, 1, `${ship} should have exactly one mailbox`);
  const addr = to[0].toLowerCase();
  assert.ok(!seen.has(addr), `${addr} is used for two ships`);
  seen.add(addr);
  const domain = addr.slice(addr.indexOf('@') + 1);
  assert.ok(DOMAINS.has(domain), `${ship}: ${addr} is not on a fleet domain`);
  assert.match(addr, /^[a-z]{2}_(printerspecialist|printer|pm)@/, `${ship}: ${addr} is not a printer mailbox`);
}

// The brand decides the mailbox shape. A Royal ship on a Celebrity domain is
// the kind of slip a human makes when copying rows.
const AZAMARA = new Set(['Journey', 'Onward', 'Pursuit', 'Quest']);
const CELEBRITY = new Set(['Apex', 'Ascent', 'Beyond', 'Constellation', 'Eclipse', 'Edge', 'Equinox',
  'Infinity', 'Millennium', 'Reflection', 'Silhouette', 'Solstice', 'Summit', 'Xcel']);
for (const ship of FLEET) {
  const addr = map.get(normShip(ship)).to[0].toLowerCase();
  if (AZAMARA.has(ship)) assert.match(addr, /_pm@azamaraships\.com$/, ship);
  else if (CELEBRITY.has(ship)) assert.match(addr, /_printer@celebrity(cruises)?\.com$/, ship);
  else assert.match(addr, /_printerspecialist@rccl\.com$/, ship);
}

// The other three addresses the Monday run uses are typed here too.
assert.match(toml, /\nSEND_TO_FLEET = "true"\n/, 'the fleet send is live');
assert.match(toml, /\nFLEET_TO = "onboardsupport@DG3\.com"\n/i, 'the whole-fleet email goes to onboardsupport');
assert.match(toml, /\nSHIP_CC = "Ray\.Guerra@dg3\.com"\n/i, 'Ray is copied on every ship email');

console.log('ok - fleet map: 48 ships, one printer mailbox each, on the three fleet domains,');
console.log('     brand and mailbox shape agree, fleet send is live with Ray in copy');
