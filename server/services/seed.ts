// Seeds synthetic tenants, clients, development users and grants, and the DED01 rule.
import { type Db, one, run, tx } from '../db/db.ts';
import { cohort } from '../connectors/synthetic-source.ts';
import { seedRules } from './rules.ts';
import { seedOperations } from './ops-seed.ts';

export function seed(db: Db): void {
  tx(db, () => {
    const c = cohort();
    for (const t of c.tenants) {
      if (!one(db, 'SELECT 1 FROM tenants WHERE tenant_id=?', t.tenantId)) run(db, 'INSERT INTO tenants VALUES (?,?)', t.tenantId, t.name);
      for (const cl of t.clients) {
        if (!one(db, 'SELECT 1 FROM clients WHERE tenant_id=? AND client_id=?', t.tenantId, cl.clientId)) run(db, 'INSERT INTO clients VALUES (?,?,?)', t.tenantId, cl.clientId, cl.name);
      }
    }
    for (const u of c.users) {
      if (!one(db, 'SELECT 1 FROM users WHERE user_id=?', u.userId)) run(db, 'INSERT INTO users VALUES (?,?)', u.userId, u.displayName);
      for (const [tenantId, clientId, role] of u.grants) {
        run(db, 'INSERT OR IGNORE INTO grants VALUES (?,?,?,?)', u.userId, tenantId, clientId, role);
      }
    }
    seedRules(db);
    seedOperations(db); // calendars, review-interval policies, attribution rule
  });
}
