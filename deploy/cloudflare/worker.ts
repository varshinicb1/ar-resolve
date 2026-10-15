// Cloudflare Worker in front of the AR Resolve container (ADR 0120). It checks the demo password,
// then forwards the request to one container running the synthetic environment.
// source: https://developers.cloudflare.com/containers/ and the @cloudflare/containers 0.3.7 README,
// retrieved 2026-10-15.
import { Container } from '@cloudflare/containers';
import { GATE_COOKIE, checkGate, checkPassword, gateToken } from './gate.ts';

interface Env {
  AR_RESOLVE: DurableObjectNamespace<ArResolveContainer>;
  DEMO_PASSWORD?: string;
}

export class ArResolveContainer extends Container {
  defaultPort = 8080;
  // Container disk is ephemeral: when the instance sleeps, the demo database and any keys entered
  // on Connect providers are gone and the next start reseeds synthetic data.
  sleepAfter = '30m';
  pingEndpoint = 'localhost/healthz';
  envVars = {
    AR_ENV: 'synthetic',
    AR_SIM_PAYER_ALWAYS_OPEN: '1',
    PORT: '8080',
  };
}

const LOGIN_PATH = '/__demo/login';

function loginPage(status: number, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AR Resolve demo</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
form{background:#fff;border:1px solid #d9d6cc;border-radius:6px;padding:24px;max-width:340px;width:100%}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:#5c5a52;font-size:14px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bdb9ad;border-radius:4px;font:inherit;margin-bottom:12px}
button{width:100%;padding:10px;border:0;border-radius:4px;background:#1f4e79;color:#fff;font:inherit;cursor:pointer}
.err{color:#9b2c2c}</style></head><body>
<form method="post" action="${LOGIN_PATH}"><h1>AR Resolve demo</h1><p${status === 401 && message ? ' class="err"' : ''}>${message || 'Synthetic data only. Enter the demo password.'}</p>
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
<button type="submit">Open demo</button></form></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === LOGIN_PATH && request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const r = await checkPassword(String(form?.get('password') ?? ''), env.DEMO_PASSWORD);
      if (!r.ok) return r.status === 503 ? new Response(r.body, { status: 503 }) : loginPage(401, r.body);
      const cookie = `${GATE_COOKIE}=${await gateToken(env.DEMO_PASSWORD!)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }

    const gate = await checkGate(request.headers.get('cookie'), env.DEMO_PASSWORD);
    if (!gate.ok) {
      if (gate.status === 503) return new Response(gate.body, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (url.pathname.startsWith('/api/')) return Response.json({ error: { code: 'demo_locked', message: gate.body } }, { status: 401 });
      return loginPage(401, '');
    }
    // One named instance: every visitor sees the same demo database.
    return env.AR_RESOLVE.getByName('demo').fetch(request);
  },
};
