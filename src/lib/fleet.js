// Per-ship addressing.
//
// Until this existed the weekly email could only go to Miguel and Ray, so the
// people who actually raise the orders never saw it. SEND_TO_FLEET was pinned
// to "false" and setting it true deliberately sent nothing.
//
// THE RULE THAT MAKES THIS SAFE: an address is only ever used if a human wrote
// it into FLEET_MAP. This module never derives an address from a ship name.
// A guessed mailbox either bounces, which is merely useless, or lands in a real
// stranger's inbox with another company's operational data in it, which is not.
// A ship with no mapping is reported to Miguel as unaddressable and its rows
// still reach him. Nothing is dropped just because it cannot be delivered.

// Ship names do not agree across sources. The ordering schedule says "Allure of
// the Seas", OBP says "Allure", Ray's mail says "Celebrity Apex". Comparing raw
// strings gives an empty result and an empty result reads as "nothing due".
export function normShip(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ms|mv|mrs|rccl|celebrity|royal caribbean|azamara)\b/g, ' ')
    .replace(/\bof the seas\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// FLEET_MAP is "Ship = address, address; Ship = address", newlines allowed.
// Lines starting with # are comments so the variable can carry a note about who
// maintains it.
export function parseFleetMap(text) {
  const map = new Map();
  const bad = [];
  for (const raw of String(text || '').split(/[;\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) { bad.push(line); continue; }
    const ship = line.slice(0, eq).trim();
    const addrs = line.slice(eq + 1).split(',').map((a) => a.trim()).filter(Boolean);
    // A ship name with no address is worse than no entry at all: it looks
    // configured and delivers nothing.
    if (!ship || !addrs.length || !addrs.every(isEmail)) { bad.push(line); continue; }
    map.set(normShip(ship), { ship, to: addrs });
  }
  return { map, bad };
}

// Deliberately strict and deliberately dumb. This is a typo guard on a value a
// human typed into a Worker variable, not an RFC 5322 implementation.
export function isEmail(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());
}

// Groups the week's actionable rows by ship and resolves each to an address.
// Returns BOTH halves - what can be sent and what cannot - because the half
// that cannot be sent is the half that needs a human.
export function planFleetSend(rows, fleetMapText) {
  const { map, bad } = parseFleetMap(fleetMapText);
  const byShip = new Map();
  for (const r of rows) {
    const key = normShip(r.ship);
    if (!byShip.has(key)) byShip.set(key, { ship: r.ship, rows: [] });
    byShip.get(key).rows.push(r);
  }

  const sendable = [];
  const unmapped = [];
  for (const [key, group] of byShip) {
    const hit = map.get(key);
    if (hit) sendable.push({ ship: group.ship, to: hit.to, rows: sortRows(group.rows) });
    else unmapped.push({ ship: group.ship, rows: sortRows(group.rows) });
  }
  const order = (a, b) => (a.ship < b.ship ? -1 : a.ship > b.ship ? 1 : 0);
  return {
    sendable: sendable.sort(order),
    unmapped: unmapped.sort(order),
    malformed: bad,
    mapped_ships: map.size,
  };
}

// Deadline order, never alphabetical. The email's whole job is to put the next
// cut-off first.
const sortRows = (rows) =>
  rows.slice().sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
