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

    // TWO ENTRIES THAT NORMALISE TO THE SAME KEY MUST NOT SILENTLY OVERWRITE.
    // map.set() kept the last one and dropped the first without a word. That is
    // either a human listing a ship twice - in which case an address they meant
    // to use is gone - or two different ships normalising together, in which
    // case one crew would receive the other crew's orders. Refuse both, report
    // both, and let the ship fall through to "unaddressable", which is loud.
    const key = normShip(ship);
    if (map.has(key)) {
      bad.push(`${line}   << duplicate of "${map.get(key).ship}" - BOTH IGNORED`);
      map.delete(key);
      continue;
    }
    map.set(key, { ship, to: addrs });
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
// gaps: schedule-free findings for ships that have NO ordering schedule. They
// carry no voyage rows, so a ship whose only finding is a delivery gap has an
// empty rows[] - and would never have been planned at all if this function only
// looked at `rows`. That ship then receives nothing, which is the silence
// [recOxbIZytNBd64AM] names as the failure the system exists to remove. The 25
// ships in that position are exactly the ones with no schedule.
// EVERY FINDING LIST THAT CAN PUT A SHIP IN THE EMAIL MUST BE ABLE TO PUT THAT
// SHIP ON THE SEND LIST. This took `gaps` but not `runsOut`, so a ship whose
// only finding was "you run out of magenta before your next container" - Quest,
// with eleven of them on 12 Sep - was never mailed at all. The runway check is
// the half of this email that names an item and a date; a planner that cannot
// see it silently discards its entire output for exactly the ships it is loudest
// about. Anything added here later goes in `extra` too.
export function planFleetSend(rows, fleetMapText, gaps = [], runsOut = []) {
  const { map, bad } = parseFleetMap(fleetMapText);
  const byShip = new Map();
  for (const r of rows) {
    const key = normShip(r.ship);
    if (!byShip.has(key)) byShip.set(key, { ship: r.ship, rows: [] });
    byShip.get(key).rows.push(r);
  }
  // A finding with no voyage row still earns the ship an email. The rows array
  // stays empty on purpose: renderWeekly draws these from opts, not from rows.
  for (const extra of [gaps, runsOut]) {
    for (const f of extra || []) {
      if (!f || !f.ship) continue;
      const key = normShip(f.ship);
      if (!byShip.has(key)) byShip.set(key, { ship: f.ship, rows: [] });
    }
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

// The Worker's endpoints have no authentication of any kind, and a Cloudflare
// Workers Build publishes a preview URL for every commit. /fleet therefore
// returns crew mailboxes over a public URL to anyone who has, or guesses, that
// address - a harvestable list of every printer in the fleet, tied to the ship
// they sail on.
//
// Masking keeps what the endpoint is FOR - checking that a ship is mapped, that
// the domain is right, that a typo is a typo - and drops what a scraper wants.
// The unmasked list needs ADMIN_KEY.
export function maskEmail(addr) {
  const s = String(addr || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at); // kept whole: a wrong domain is the common error
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
}

// Deadline order, never alphabetical. The email's whole job is to put the next
// cut-off first.
const sortRows = (rows) =>
  rows.slice().sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
