// One-off online backup (ADR 0090). Safe while the API and worker run.
//   npm run backup                       # into AR_BACKUP_DIR, encrypted per AR_BACKUP_ENCRYPT
//   npm run backup -- --dir /path        # another directory
import { openDb } from '../server/db/db.ts';
import { loadConfig, ConfigError } from '../server/config.ts';
import { backupNow } from '../server/ops/backup.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
let cfg;
try { cfg = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
const dir = arg('--dir') ?? cfg.backup.dir ?? 'data/backups';
const db = openDb(cfg.dbPath);
try {
  const r = await backupNow(db, { dir, encrypt: cfg.backup.encrypt, keep: cfg.backup.keep });
  console.log(JSON.stringify({ ok: true, ...r }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: (e as Error).message }));
  process.exitCode = 1;
} finally { db.close(); }
