// Restore a backup (ADR 0090). STOP the API and worker first.
//   npm run restore -- <backup file> [--target /data/ar-resolve.db] [--force]
// The backup is decrypted with the PHI key it names (must be in AR_PHI_KEYS), checked against its
// manifest digest, integrity-checked and checked for applied migrations before anything is
// replaced. An existing database is moved aside (<db>.pre-restore-<time>), never deleted.
import { restoreBackup } from '../server/ops/backup.ts';
import { loadConfig, ConfigError } from '../server/config.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--target');
const ti = args.indexOf('--target');
if (!file) { console.error('usage: npm run restore -- <backup file> [--target <db path>] [--force]'); process.exit(2); }
let target = ti >= 0 ? args[ti + 1] : undefined;
if (!target) {
  try { target = loadConfig().dbPath; } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(78); } throw e; }
}
try {
  const r = await restoreBackup(file, target, { force: args.includes('--force') });
  console.log(JSON.stringify({ ok: true, ...r }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: (e as Error).message }));
  process.exitCode = 1;
}
