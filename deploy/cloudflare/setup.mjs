#!/usr/bin/env node
// One-page local setup for the hosted demo (ADR 0120). Run on the machine that will deploy:
//   node deploy/cloudflare/setup.mjs            (add --dry-run to build without uploading)
// It opens a page on http://127.0.0.1 where you enter the Cloudflare API token, the account ID and
// a demo password, then runs `wrangler deploy` with them and shows the URL.
//
// Where the values go: the token and account ID only into the environment of the wrangler child
// process; the password only into a 0600 temp file passed to `wrangler deploy --secrets-file`,
// deleted as soon as wrangler exits. Nothing is written to the repo, logged or kept after exit.
// The page listens on 127.0.0.1 only and every request must carry a random one-time key that is
// printed in the terminal, so another site open in the browser cannot drive it.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const KEY = randomBytes(18).toString('base64url');
const isWin = process.platform === 'win32';

const state = { running: false, done: false, ok: false, url: null, log: [] };
let secrets = [];

function redact(s) {
  let out = String(s);
  for (const v of secrets) if (v && v.length >= 4) out = out.split(v).join('[hidden]');
  return out;
}
function log(line) {
  for (const l of redact(line).split(/\r?\n/)) if (l.trim()) state.log.push(l.replace(/\x1b\[[0-9;]*m/g, ''));
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

// shell:true is needed for npx/npm on Windows; arguments here are fixed strings or a temp path
// we created, never user input.
function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    log(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd: HERE, shell: isWin, env: { ...process.env, ...env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; log(d); });
    child.stderr.on('data', (d) => { out += d; log(d); });
    child.on('error', (e) => { log(`could not start ${cmd}: ${e.message}`); resolve({ code: -1, out }); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function deploy({ token, accountId, password }) {
  state.running = true;
  secrets = [token, password];
  const env = DRY_RUN ? {} : { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
  let tmp = null;
  try {
    log('Checking Docker (needed to build the app image)...');
    if ((await run('docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0) throw new Error('Docker is not running. Start Docker Desktop and try again.');

    if (!existsSync(join(HERE, 'node_modules', 'wrangler'))) {
      log('Installing wrangler for this folder (first run only)...');
      if ((await run('npm', ['ci', '--no-audit', '--no-fund'])).code !== 0) throw new Error('npm ci failed.');
    }

    if (!DRY_RUN) {
      log('Checking the Cloudflare token...');
      if ((await run('npx', ['wrangler', 'whoami'], env)).code !== 0) throw new Error('Cloudflare did not accept the token or account ID.');
    }

    tmp = mkdtempSync(join(tmpdir(), 'ar-demo-'));
    const secretsFile = join(tmp, 'secrets.json');
    writeFileSync(secretsFile, JSON.stringify({ DEMO_PASSWORD: password }), { mode: 0o600 });

    log(DRY_RUN ? 'Building (dry run, nothing is uploaded)...' : 'Deploying. The first deploy builds and uploads the image and can take several minutes...');
    const args = ['wrangler', 'deploy', '--secrets-file', secretsFile];
    if (DRY_RUN) args.push('--dry-run', '--outdir', join(tmp, 'dist'));
    const r = await run('npx', args, env);
    if (r.code !== 0) throw new Error('wrangler deploy failed. The log above says why.');

    state.url = (r.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) ?? [null])[0];
    state.ok = true;
    log(DRY_RUN ? 'Dry run passed.' : `Deployed${state.url ? `: ${state.url}` : ''}. Cloudflare can take a few minutes to start the container the first time.`);
  } catch (e) {
    log(`Stopped: ${e.message}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    secrets = secrets.map(() => '');
    state.running = false;
    state.done = true;
  }
}

const page = (port) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy AR Resolve demo</title><style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1d1b;--muted:#5c5a52;--line:#d9d6cc;--accent:#1f4e79;--bad:#9b2c2c;--good:#2f6b3a}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:32px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;margin:0 0 6px}p.lead{color:var(--muted);margin:0 0 20px}
form,section{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:20px;margin-bottom:16px}
label{display:block;font-weight:600;margin:14px 0 4px}label:first-child{margin-top:0}small{display:block;color:var(--muted);font-weight:400}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #bdb9ad;border-radius:4px;font:inherit}
button{margin-top:18px;padding:10px 16px;border:0;border-radius:4px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}pre{background:#1d1d1b;color:#e8e6df;padding:12px;border-radius:4px;max-height:360px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--good);font-weight:600}.bad{color:var(--bad);font-weight:600}a{color:var(--accent)}
</style></head><body><main>
<h1>Deploy the AR Resolve demo to Cloudflare</h1>
<p class="lead">${DRY_RUN ? 'Dry run: builds everything but uploads nothing. ' : ''}These values stay on this computer. They are passed to wrangler for this one deploy and are not saved.</p>
<form id="f">
<label for="token">Cloudflare API token<small>Cloudflare dashboard &gt; My Profile &gt; API Tokens. Use the "Edit Cloudflare Workers" template.</small></label>
<input id="token" name="token" type="password" autocomplete="off" required>
<label for="account">Account ID<small>Shown on the Workers &amp; Pages overview page (32 characters).</small></label>
<input id="account" name="accountId" autocomplete="off" pattern="[0-9a-fA-F]{32}" required>
<label for="pw">Demo password<small>Visitors type this to open the demo. At least 12 characters.</small></label>
<input id="pw" name="password" type="password" minlength="12" autocomplete="new-password" required>
<button id="go" type="submit">${DRY_RUN ? 'Run dry run' : 'Deploy'}</button>
</form>
<section id="out" hidden><div id="result">Working...</div><pre id="log"></pre></section>
</main><script>
const KEY=${JSON.stringify(KEY)};
const f=document.getElementById('f'),out=document.getElementById('out'),logEl=document.getElementById('log'),res=document.getElementById('result');
f.addEventListener('submit',async(e)=>{e.preventDefault();document.getElementById('go').disabled=true;
 const body=Object.fromEntries(new FormData(f));f.reset();out.hidden=false;
 const r=await fetch('/deploy',{method:'POST',headers:{'content-type':'application/json','x-setup-key':KEY},body:JSON.stringify(body)});
 if(!r.ok){res.innerHTML='<span class="bad">'+(await r.text())+'</span>';document.getElementById('go').disabled=false;return;}
 poll();});
async function poll(){const s=await (await fetch('/status',{headers:{'x-setup-key':KEY}})).json();
 logEl.textContent=s.log.join('\\n');logEl.scrollTop=logEl.scrollHeight;
 if(!s.done){res.textContent='Working...';return setTimeout(poll,1500);}
 if(s.ok){res.innerHTML='<span class="ok">Done.</span> '+(s.url?'Your demo: <a href="'+s.url+'" target="_blank" rel="noopener">'+s.url+'</a>. You can close this page and press Ctrl+C in the terminal.':'');}
 else{res.innerHTML='<span class="bad">Not deployed.</span> See the log below. Fix the problem, then reload this page and try again.';}}
</script></body></html>`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 10_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

const server = createServer(async (req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'" });
    res.end(body);
  };
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, 'Wrong host.');

  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('k') !== KEY) return send(403, 'Open the exact link printed in the terminal.');
    return send(200, page(port), 'text/html; charset=utf-8');
  }
  if (req.headers['x-setup-key'] !== KEY) return send(403, 'Missing setup key.');
  if (req.method === 'GET' && url.pathname === '/status') return send(200, JSON.stringify({ ...state, log: state.log }), 'application/json');
  if (req.method === 'POST' && url.pathname === '/deploy') {
    if (state.running) return send(409, 'A deploy is already running.');
    let body;
    try { body = await readJson(req); } catch { return send(400, 'Bad request.'); }
    const token = String(body.token ?? '').trim();
    const accountId = String(body.accountId ?? '').trim();
    const password = String(body.password ?? '');
    if (!DRY_RUN && token.length < 20) return send(400, 'The API token looks too short.');
    if (!DRY_RUN && !/^[0-9a-f]{32}$/i.test(accountId)) return send(400, 'The account ID should be 32 letters and digits.');
    if (password.length < 12) return send(400, 'The demo password needs at least 12 characters.');
    Object.assign(state, { done: false, ok: false, url: null, log: [] });
    deploy({ token, accountId, password });
    return send(202, 'started');
  }
  send(404, 'Not found.');
});

const want = Number(process.env.SETUP_PORT ?? 8790);
server.listen(want, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${server.address().port}/?k=${KEY}`;
  console.log(`\nAR Resolve demo setup${DRY_RUN ? ' (dry run)' : ''}\nOpen this link in your browser:\n\n  ${link}\n\nPress Ctrl+C to stop.\n`);
});
