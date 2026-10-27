// node test/quantity-rules.test.mjs
//
// THE ONE NUMBER THE CREW ACTS ON. Every branch of orderQuantity() is one of
// Ray Guerra's written rules (Questions for Ray -RG09012026.docx, 1 Sep 2026;
// Ray_Questions_Round4 RG.docx, 4 Sep 2026; round 9, recGzzU4LphovQ1ne). This
// file pins each rule to the sentence it came from, so a future "improvement"
// that drifts from Ray's words fails here first. A quantity without a named
// source is the exact failure the Brain's corrections layer exists for.

import assert from 'node:assert';
import { orderQuantity, withQuantity, TONER_BUFFER, TONER_BUFFER_LONG_HAUL, WASTE_BOX_ORDER, PAPER_PALLET, RADIANT_MIN, deliveryClass, tonerSpare } from '../src/lib/runway.js';

const q = (o) => orderQuantity(o);

// Ray Q20: "order 3 toners over their consumption amount". +3 where delivery
// comes within the month; +4 long-haul (Ray, 15 Oct; block at the end). With
// no port given, the +3 floor.
assert.equal(TONER_BUFFER, 3);
assert.deepEqual(q({ item: 'TN619M MAGENTA TONER', brand: 'Royal', rate: 14, inTransit: 0, cycleDays: 30 }),
  { qty: 17, basis: '14 used in 30 days + 3 spare' });
// Consumption is scaled to the stretch until the landing after next, not to a
// calendar month: 14 a month over a 15-day cycle is 7.
assert.equal(q({ item: 'TN634K BLACK TONER', brand: 'Celebrity', rate: 14, inTransit: 0, cycleDays: 15 }).qty, 7 + 3);
// What is already on that container is not ordered twice.
assert.equal(q({ item: 'TN619C CYAN TONER', brand: 'Royal', rate: 5, inTransit: 35, cycleDays: 30 }).qty, 0);

// Ray 4 Sep Q7: "the exact order is 12 pieces per ship from all brands";
// round 8: "12 pieces per order no exceptions"; 27 Oct 2026, on Star's
// "Add 5" (a top-up to 12 read as a par): "System is still not understanding
// the 12 piece rule for waste toners". 12 is the ORDER, like paper's pallet:
// what is aboard when it lands does not shave it, and what is already on the
// order is not ordered twice.
assert.equal(WASTE_BOX_ORDER, 12);
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, inTransit: 0 }).qty, 12);
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Azamara', rate: 3, inTransit: 12 }).qty, 0);
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, inTransit: 2, onHandAtLanding: 5 }).qty, 12, 'never a top-up: 12 or nothing');
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, inTransit: 5, cycleDays: 30 }).qty, 0, 'enough already on the order for the cycle');
assert.match(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, onHandAtLanding: 5 }).basis, /a waste box order is 12 pieces/);
assert.ok(!/par/.test(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4 }).basis), 'the word par never appears on a waste box line');

// Ray Q19: paper "always ordered in a pallet of 40 cases for royal and
// celebrity ships" - and paper has no par, so consumption never sets the size.
assert.equal(PAPER_PALLET, 40);
assert.equal(q({ item: '20 LBS 8.5 x 11 DG3 PAPER', brand: 'Royal', rate: 41, inTransit: 0, cycleDays: 28 }).qty, 40);
assert.equal(q({ item: '20 LBS 11 x 17 DG3 PAPER', brand: 'Celebrity', rate: 20, inTransit: 120, cycleDays: 28 }).qty, 0);
// "Azamara it's based on strict consumption due to space so they could not
// accept 40 cases rather what they use."
assert.equal(q({ item: '20 LBS 8.5 x 11 DG3 PAPER', brand: 'Azamara', rate: 23, inTransit: 10, cycleDays: 30 }).qty, 13);
assert.equal(q({ item: '8.5 x 14 #80 GLOSS TEXT', brand: 'Azamara', rate: 26, inTransit: 5, cycleDays: 30 }).qty, 21);

// Ray Q20 / 4 Sep Q8: Radiant "minimum of 10 cases ... if a ship needs 14
// cases, they can order the 14".
assert.equal(RADIANT_MIN, 10);
assert.equal(q({ item: 'RADIANT WHITE 28# 11x17', brand: 'Celebrity', rate: 12, inTransit: 0, cycleDays: 20 }).qty, 10);
assert.equal(q({ item: 'RADIANT WHITE 28# 11x17', brand: 'Celebrity', rate: 14, inTransit: 0, cycleDays: 30 }).qty, 14);
assert.equal(q({ item: 'RADIANT WHITE 28# 11x17', brand: 'Celebrity', rate: 12, inTransit: 52, cycleDays: 30 }).qty, 0);

// Ray 4 Sep Q1: Azamara MFD toner "have a par level assigned on OBP, we follow
// this par level and replenish only as needed". Top-up to par; no par, no number.
assert.equal(q({ item: 'TN324M MAGENTA TONER', brand: 'Azamara', rate: 5, inTransit: 3, cycleDays: 30, parQty: 5 }).qty, 2);
assert.equal(q({ item: 'TN-328C CYAN TONER', brand: 'Azamara', rate: 10, inTransit: 0, cycleDays: 30, parQty: 4 }).qty, 4);
assert.equal(q({ item: 'TNP79K - BLACK TONER (YIELD: 13K )', brand: 'Azamara', rate: 2, inTransit: 0, parQty: null }), null);
// A par that lasts less than the cycle is said so, in the basis, not hidden.
assert.match(q({ item: 'TNP75 BLACK TONER BH 5000i (YIELD:', brand: 'Azamara', rate: 6, inTransit: 0, cycleDays: 30, parQty: 2 }).basis,
  /2 lasts about 10 days/);
// The colour letter follows the model with no space: "TN324M" must still match.
assert.ok(q({ item: 'TN514Y YELLOW TONER', brand: 'Azamara', rate: 2, inTransit: 0, parQty: 3 }));

// An item with no sourced rule gets no number. Never an estimate.
assert.equal(q({ item: 'SOME OTHER SUPPLY', brand: 'Royal', rate: 5 }), null);

// withQuantity: the order is the ship's next OPEN order (Ray Q21 - after the
// due date it is processed or missed); the cycle runs from that landing to the
// landing after; absent, a month. The container already on its way (next_loading)
// is a fact for the reader, not the order the line goes on.
const f = { ship: 'Quest', item: 'TN619M MAGENTA TONER', rate: 14, on_hand: 3, stockout: '2026-10-13', next_loading: '2026-10-14' };
const a = withQuantity(f, { brand: 'Azamara', parQty: 5, due: '2026-12-08', lands: '2026-12-18', until: '2027-01-02', coming: 10 });
assert.equal(a.order_due, '2026-12-08');
assert.equal(a.order_lands, '2026-12-18');
assert.equal(a.cycle_days, 15);
assert.equal(a.cover_to, '2027-01-02');
assert.equal(a.add_qty, 7 + 3 - 10);
const b = withQuantity(f, { brand: 'Azamara', parQty: 5 });
assert.equal(b.order_due, null);
assert.equal(b.cycle_days, 30);
assert.equal(b.cover_to, null);
assert.equal(b.add_qty, 17);

// The par rule is a top-up: when the open order lands BEFORE the item runs dry,
// what is still aboard that day counts. 10 aboard, 6 a month, lands in 30 days
// -> about 4 left; par 5 -> add 1, not 5.
const mfd = { ship: 'Onward', item: 'TNP75 BLACK TONER', rate: 6, on_hand: 10, stockout: '2026-11-04', next_loading: null };
const c = withQuantity(mfd, { brand: 'Azamara', parQty: 5, due: '2026-10-06', lands: '2026-10-15', until: null, coming: 0, today: '2026-09-15', arrivals: [] });
assert.equal(c.add_qty, 1);
assert.match(c.add_basis, /about 4 still aboard/);
// Same item, order landing after the stockout: nothing aboard, top up to par.
const d = withQuantity(mfd, { brand: 'Azamara', parQty: 5, due: '2026-11-06', lands: '2026-11-20', until: null, coming: 0, today: '2026-09-15', arrivals: [] });
assert.equal(d.add_qty, 5);

console.log("ok - quantities: every branch is one of Ray's written rules - +3 toner, 12 waste");
console.log('     boxes, 40-case pallets, 10-case Radiant minimum, Azamara to consumption or OBP par');

// THE TONER SPARE FOLLOWS DELIVERY FREQUENCY (Ray, 15 Oct 2026): "USA ships
// have a 3+ rule and international ships have a 4+ rule"; read with his 7 Sep
// answer that Vancouver, St Maarten, Oranjestad, Freeport and Puntarenas are
// "considered international" but delivered within the month, so +3.
{
  assert.equal(TONER_BUFFER_LONG_HAUL, 4);
  // Every loading port in the live schedule on 15 Oct 2026 (366 future orders,
  // 38 spellings) is on one list or the other. A new port shows as not on file.
  const live = {
    monthly: ['PORT EVERGLADES', 'PORTEVERGLADES', 'MIAMI', 'Miami', 'PORT CANAVERAL', 'TAMPA', 'LOS ANGELES',
      'GALVESTON', 'SAN DIEGO', 'SAN JUAN', 'San Juan', 'ORANJESTAD', 'NEW ORLEANS', 'BAYONNE', 'FREEPORT',
      'Victoria', 'Seattle', 'San Francisco', 'ST MAARTEN'],
    'long-haul': ['CIVITAVECCHIA', 'SINGAPORE', 'Singapore', 'BRISBANE', 'SYDNEY', 'MONTEVIDEO', 'Montevideo',
      'BARCELONA', 'VENICE (RAVENNA)', 'Busan', 'BUSAN', 'TAURANGA', 'Soul', 'San Antonio', 'OSAKA', 'NAGASAKI',
      'Lisbon', 'BUENOS AIRES', 'Auckland'],
  };
  for (const [cls, ports] of Object.entries(live)) for (const port of ports) assert.equal(deliveryClass(port), cls, port);
  for (const port of ['Vancouver', 'ST MAARTEN', 'ORANJESTAD', 'FREEPORT', 'PUNTARENAS'])
    assert.equal(tonerSpare({ brand: 'Royal', port, nextPort: 'MIAMI' }).spare, 3, `${port}: Ray 7 Sep, delivered within the month`);
  assert.equal(deliveryClass(null), null);
  assert.equal(deliveryClass('ENSENADA'), null, 'a port on neither list is not guessed');

  // The four moments of an itinerary.
  assert.deepEqual(tonerSpare({ brand: 'Celebrity', port: 'PORT EVERGLADES', nextPort: 'PORT EVERGLADES' }), { spare: 3, note: '' },
    'a US order with a US loading after it: +3');
  assert.deepEqual(tonerSpare({ brand: 'Celebrity', port: 'PORT EVERGLADES', nextPort: 'CIVITAVECCHIA' }),
    { spare: 4, note: 'next loading Civitavecchia is long-haul' },
    'the last US order before the ship leaves: +4 (the Sep spec, "the last US order before the ship goes international takes +4")');
  assert.deepEqual(tonerSpare({ brand: 'Celebrity', port: 'BARCELONA', nextPort: 'BARCELONA' }),
    { spare: 4, note: 'long-haul delivery, Barcelona' }, 'an order loading abroad: +4');
  assert.equal(tonerSpare({ brand: 'Celebrity', port: 'VENICE (RAVENNA)', nextPort: 'PORT EVERGLADES' }).spare, 4,
    'the last order loaded abroad is still used abroad: +4');
  assert.equal(tonerSpare({ brand: 'Celebrity', port: 'PORT EVERGLADES', nextPort: 'MIAMI' }).spare, 3,
    'Ray: "the 3+ rule will come into play when they do their first order here"');
  // Azamara is "exception cruise line, flat" +3 in the September spec; Ray's
  // 15 Oct answer did not touch it.
  assert.deepEqual(tonerSpare({ brand: 'Azamara', port: 'Singapore', nextPort: 'Busan' }), { spare: 3, note: '' });
  // Not on file: the +3 floor, and the line says so rather than guessing.
  assert.deepEqual(tonerSpare({ brand: 'Royal', port: 'ENSENADA', nextPort: 'LOS ANGELES' }),
    { spare: 3, note: 'delivery frequency for Ensenada not on file' });
  assert.equal(tonerSpare({ brand: 'Royal' }).spare, 3, 'no order, no port: the floor, silently');

  // Infinity's yellow, the case Ray answered on: 8 a month, loading in Barcelona.
  assert.deepEqual(q({ item: 'TN619Y YELLOW TONER', brand: 'Celebrity', rate: 8, cycleDays: 30, port: 'BARCELONA', nextPort: 'BARCELONA' }),
    { qty: 12, basis: '8 used in 30 days + 4 spare (long-haul delivery, Barcelona)' });
  // The port reaches the rule through withQuantity, as runwayDb passes it.
  const w = withQuantity({ ship: 'Ascent', item: 'TN619C CYAN TONER', description: 'TN619C CYAN TONER', rate: 15, on_hand: 0 },
    { brand: 'Celebrity', parQty: 10, due: '2026-10-22', lands: '2026-11-20', until: '2026-12-20', port: 'PORT EVERGLADES', nextPort: 'CIVITAVECCHIA', today: '2026-10-15' });
  assert.equal(w.add_qty, 19, '15 a month over 30 days, plus 4: the last order before Europe');
  // Waste boxes and MFD toner are outside the spare rule.
  assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, port: 'BARCELONA' }).qty, 12);
  console.log('ok - quantities: the toner spare is +3 where delivery comes within the month and +4 long-haul,');
  console.log('     including the last order before a ship leaves; Azamara flat +3; an unknown port is named');
}
