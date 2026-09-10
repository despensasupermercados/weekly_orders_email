// node test/endpoints.test.mjs
// These endpoints return the fleet's ordering position ship by ship. They were
// public, on a Worker whose preview URL is published for every commit, and
// azamara@cims.work now routes live fleet mail to it. The gate below is the
// whole point of this file.

import worker from '../src/index.js';
import assert from 'node:assert';

const call = (path, env = {}) => worker.fetch(new Request(`https://w.example${path}`), env);

// FAIL CLOSED. With no ADMIN_KEY configured these must refuse, not serve. An
// access control that disables itself when unconfigured is not one.
for (const p of ['/states', '/misses', '/azamara', '/watchdog', '/preview', '/fleet',
                 '/quantity', '/anomalies', '/escalations', '/data-faults', '/po-not-recorded']) {
  const r = await call(p, {});
  assert.equal(r.status, 503, `${p} must refuse when ADMIN_KEY is unset`);
  const body = await r.json();
  assert.ok(/ADMIN_KEY/.test(body.error), `${p} must name the missing secret`);
}

// A wrong key is 401, and the comparison must not leak length by short-circuit.
const wrong = await call('/states?key=nope', { ADMIN_KEY: 'the-real-key' });
assert.equal(wrong.status, 401);
const empty = await call('/states?key=', { ADMIN_KEY: 'the-real-key' });
assert.equal(empty.status, 401, 'an empty key is not a pass');
const missing = await call('/states', { ADMIN_KEY: 'the-real-key' });
assert.equal(missing.status, 401, 'no key at all is not a pass');

// /health stays open on purpose: it is how you check a deploy landed, and it
// carries counts rather than the fleet's position. It must NOT be gated, or the
// go-live check in the README stops working.
const health = await call('/health', {
  ADMIN_KEY: 'k',
  HON: { prepare: () => ({ first: async () => ({ n: 0, d: null, m: null }) }) },
});
assert.equal(health.status, 200, '/health must stay reachable');

// A correct key gets past the gate. It may still fail deeper for want of a
// database - what matters here is that it is no longer 401 or 503.
const ok = await call('/states?key=the-real-key', { ADMIN_KEY: 'the-real-key' })
  .then((r) => r.status).catch(() => 'threw');
assert.ok(ok !== 401 && ok !== 503, 'a correct key must pass the gate');

console.log('ok - endpoints: fleet data refuses to serve without ADMIN_KEY, a wrong or absent');
console.log('     key is rejected, and /health stays open so the deploy check still works');
