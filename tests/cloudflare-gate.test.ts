// ADR 0120: the password gate in front of the hosted synthetic demo on Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_COOKIE, checkGate, checkPassword, gateToken } from '../deploy/cloudflare/gate.ts';

const PW = 'correct-horse-battery';

test('cloudflare gate: no DEMO_PASSWORD (or a short one) locks the demo', async () => {
  for (const pw of [undefined, '', 'short']) {
    const c = await checkGate(`${GATE_COOKIE}=${await gateToken(pw ?? '')}`, pw);
    assert.equal(!c.ok && c.status, 503);
    const p = await checkPassword(pw ?? '', pw);
    assert.equal(!p.ok && p.status, 503);
  }
});

test('cloudflare gate: the right password and its cookie pass, anything else is 401', async () => {
  assert.deepEqual(await checkPassword(PW, PW), { ok: true });
  for (const wrong of ['', 'wrong-password-xx', PW + 'x', PW.slice(1)]) {
    const r = await checkPassword(wrong, PW);
    assert.equal(!r.ok && r.status, 401, wrong);
  }
  const token = await gateToken(PW);
  assert.deepEqual(await checkGate(`ar_session=abc; ${GATE_COOKIE}=${token}`, PW), { ok: true });
  for (const h of [null, '', `${GATE_COOKIE}=`, `${GATE_COOKIE}=${PW}`, `${GATE_COOKIE}=${await gateToken('another-password-1')}`, `x${GATE_COOKIE}=${token}`]) {
    const r = await checkGate(h, PW);
    assert.equal(!r.ok && r.status, 401, String(h));
  }
});
