// node test/quantity-rules.test.mjs
//
// THE ONE NUMBER THE CREW ACTS ON. Every branch of orderQuantity() is one of
// Ray Guerra's written rules (Questions for Ray -RG09012026.docx, 1 Sep 2026;
// Ray_Questions_Round4 RG.docx, 4 Sep 2026; round 9, recGzzU4LphovQ1ne). This
// file pins each rule to the sentence it came from, so a future "improvement"
// that drifts from Ray's words fails here first. A quantity without a named
// source is the exact failure the Brain's corrections layer exists for.

import assert from 'node:assert';
import { orderQuantity, withQuantity, TONER_BUFFER, WASTE_BOX_ORDER, PAPER_PALLET, RADIANT_MIN } from '../src/lib/runway.js';

const q = (o) => orderQuantity(o);

// Ray Q20: "order 3 toners over their consumption amount". +3 everywhere -
// the Brain corrected the nationality version on 7 Sep (recN47v4lrTkjQNpO).
assert.equal(TONER_BUFFER, 3);
assert.deepEqual(q({ item: 'TN619M MAGENTA TONER', brand: 'Royal', rate: 14, inTransit: 0, cycleDays: 30 }),
  { qty: 17, basis: '14 used in 30 days + 3 spare' });
// Consumption is scaled to the stretch until the landing after next, not to a
// calendar month: 14 a month over a 15-day cycle is 7.
assert.equal(q({ item: 'TN634K BLACK TONER', brand: 'Celebrity', rate: 14, inTransit: 0, cycleDays: 15 }).qty, 7 + 3);
// What is already on that container is not ordered twice.
assert.equal(q({ item: 'TN619C CYAN TONER', brand: 'Royal', rate: 5, inTransit: 35, cycleDays: 30 }).qty, 0);

// Ray 4 Sep Q7: "the exact order is 12 pieces per ship from all brands".
assert.equal(WASTE_BOX_ORDER, 12);
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Royal', rate: 4, inTransit: 0 }).qty, 12);
assert.equal(q({ item: 'WASTE TONER BOX (DG3)', brand: 'Azamara', rate: 3, inTransit: 12 }).qty, 0);

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

// withQuantity: the cycle is next landing -> landing after; absent, a month.
const f = { ship: 'Quest', item: 'TN619M MAGENTA TONER', rate: 14, next_loading: '2026-10-14' };
const a = withQuantity(f, { brand: 'Azamara', parQty: 5, inTransit: 10, nextAfter: '2026-10-29' });
assert.equal(a.cycle_days, 15);
assert.equal(a.cover_to, '2026-10-29');
assert.equal(a.add_qty, 7 + 3 - 10);
const b = withQuantity(f, { brand: 'Azamara', parQty: 5, inTransit: 0, nextAfter: null });
assert.equal(b.cycle_days, 30);
assert.equal(b.cover_to, null);
assert.equal(b.add_qty, 17);

console.log("ok - quantities: every branch is one of Ray's written rules - +3 toner, 12 waste");
console.log('     boxes, 40-case pallets, 10-case Radiant minimum, Azamara to consumption or OBP par');
