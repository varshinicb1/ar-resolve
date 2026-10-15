// Operator provisioning CLI (ADR 0090). Run inside the deployment (e.g. docker compose exec app).
//   npm run admin -- tenant-add <tenantId> "<name>"
//   npm run admin -- client-add <tenantId> <clientId> "<name>"
//   npm run admin -- user-add <userId> "<display name>"
//   npm run admin -- grant <userId> <tenantId> <clientId> <role>
//   npm run admin -- revoke-grant <userId> <tenantId> <clientId> <role>
//   npm run admin -- sso-link <userId> --issuer <url> (--subject <sub> | --email <address>)
//   npm run admin -- sso-disable <linkId>
//   npm run admin -- sessions-revoke <userId>
//   npm run admin -- list
// Every command needs --actor "<your name>"; it is recorded in auth_events (and the audit log for grants).
import { openDb } from '../server/db/db.ts';
import { loadConfig, ConfigError } from '../server/config.ts';
import { addClient, addTenant, addUser, disableIdentity, linkIdentity, overview, revokeSessionsFor, setGrant } from '../server/services/admin.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const actorName = flag('--actor');
const issuer = flag('--issuer');
const subject = flag('--subject');
const email = flag('--email');
const [cmd, ...pos] = argv;

let cfg;
try { cfg = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
if (cmd !== 'list' && (!actorName || actorName.trim().length < 2)) { console.error('--actor "<your name>" is required'); process.exit(2); }
const actor = `operator:${(actorName ?? 'list').trim()}`;
const db = openDb(cfg.dbPath);
try {
  const out = (() => {
    switch (cmd) {
      case 'tenant-add': return addTenant(db, actor, pos[0], pos[1]);
      case 'client-add': return addClient(db, actor, pos[0], pos[1], pos[2]);
      case 'user-add': return addUser(db, actor, pos[0], pos[1]);
      case 'grant': return setGrant(db, actor, pos[0], pos[1], pos[2], pos[3], true);
      case 'revoke-grant': return setGrant(db, actor, pos[0], pos[1], pos[2], pos[3], false);
      case 'sso-link': return linkIdentity(db, actor, { userId: pos[0], issuer: issuer ?? cfg.oidc?.issuer ?? '', subject, email });
      case 'sso-disable': return disableIdentity(db, actor, pos[0]);
      case 'sessions-revoke': return revokeSessionsFor(db, actor, pos[0]);
      case 'list': return overview(db);
      default: throw new Error(`unknown command ${cmd ?? ''}; see the header of scripts/admin.ts`);
    }
  })();
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally { db.close(); }
