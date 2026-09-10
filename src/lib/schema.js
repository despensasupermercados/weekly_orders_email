// Column probes.
//
// Every query in this Worker that touches a table it does not own is one column
// rename away from returning zero rows, SILENTLY. That is the single failure
// mode this project keeps rediscovering: `eta` was an Excel serial in a TEXT
// column and every date comparison matched nothing while reporting confidently.
//
// The standing rule is "a filter returning zero rows is a bug until proven
// otherwise". A probe is how you prove it. Any check built on a table whose
// columns we cannot see must report CANNOT RUN, never a clean zero.

// Table names are internal constants, never user input, but PRAGMA cannot take
// a bound parameter so the value is interpolated. Refuse anything that is not a
// bare identifier rather than trusting the call sites to stay careful.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function columnsOf(db, table) {
  if (!IDENT.test(table)) throw new Error(`unsafe table name: ${table}`);
  try {
    const r = await db.prepare(`PRAGMA table_info(${table})`).all();
    const cols = (r.results || []).map((c) => String(c.name));
    return cols.length ? new Set(cols) : null; // no columns = no table
  } catch (_) {
    return null; // table absent, or the binding points somewhere unexpected
  }
}

// Returns { ok, missing[], columns } so a caller can say exactly WHICH column is
// gone. "quantity check could not run" is useless; "par has no column
// `par_qty`" is a five-minute fix.
export async function require_(db, table, needed) {
  const columns = await columnsOf(db, table);
  if (!columns) return { ok: false, table, missing: needed.slice(), columns: null, reason: `table ${table} not found` };
  const missing = needed.filter((c) => !columns.has(c));
  return {
    ok: missing.length === 0,
    table,
    missing,
    columns,
    reason: missing.length ? `${table} is missing: ${missing.join(', ')}` : null,
  };
}

// First column present from a list of accepted spellings. cims-hon's tables were
// built by hand over months and the same concept appears under more than one
// name; guessing one and getting a silent zero is the trap.
export function firstPresent(columns, candidates) {
  if (!columns) return null;
  for (const c of candidates) if (columns.has(c)) return c;
  return null;
}
