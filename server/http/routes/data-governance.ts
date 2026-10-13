// ADR 0080 routes (follow-ups to the clinic-receptionist port): named API keys, retention policy
// and purge, two-person account deletion, approval binding after redaction, PHI key rotation,
// call recording policy and recordings, and the value / operations card.
import type { ModuleApi } from '../app.ts';
import { requirePerm } from '../../services/auth.ts';
import { createKey, listKeys, revokeKey } from '../../services/access.ts';
import { approvalBinding, cancelDeletion, decideDeletion, listDeletions, purgeExpired, requestDeletion, retentionView, setRetention } from '../../services/retention.ts';
import { keyStatus, retireKey, runRekey, startRekey } from '../../services/phi-keys.ts';
import { getRecording, listRecordings, recordingView, setRecordingPolicy } from '../../services/recording.ts';
import { computeValue } from '../../services/value.ts';

export function register({ db, route, scoped }: ModuleApi): void {
  // ---- named API keys (service accounts)
  route('GET', '/api/access/keys', (ctx) => listKeys(db, scoped(ctx)));
  route('POST', '/api/access/keys', (ctx) => createKey(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/access/keys/:id/revoke', (ctx) => revokeKey(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));

  // ---- retention
  route('GET', '/api/governance/retention', (ctx) => retentionView(db, scoped(ctx)));
  route('POST', '/api/governance/retention', (ctx) => setRetention(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/governance/retention/purge', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'manage_retention');
    return purgeExpired(db, s, { dryRun: ctx.body?.dryRun !== false });
  });

  // ---- account deletion (supervisor requests, a second person approves)
  route('GET', '/api/governance/deletions', (ctx) => listDeletions(db, scoped(ctx)));
  route('POST', '/api/accounts/:id/deletion-request', (ctx) => requestDeletion(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/governance/deletions/:id/decide', (ctx) => decideDeletion(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/governance/deletions/:id/cancel', (ctx) => cancelDeletion(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('GET', '/api/governance/actions/:id/binding', (ctx) => approvalBinding(db, scoped(ctx), ctx.params.id));

  // ---- PHI key rotation
  route('GET', '/api/governance/phi-keys', (ctx) => keyStatus(db, scoped(ctx)));
  route('POST', '/api/governance/phi-keys/rekey', (ctx) => startRekey(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/governance/phi-keys/rekey/:jobId/run', (ctx) => runRekey(db, scoped(ctx), ctx.params.jobId, Math.min(500, Math.max(1, Number(ctx.body?.maxBatches ?? 50) || 50))));
  route('POST', '/api/governance/phi-keys/:keyId/retire', (ctx) => retireKey(db, scoped(ctx), ctx.params.keyId, ctx.body ?? {}));

  // ---- call recording (disabled by default; simulated metadata only)
  route('GET', '/api/governance/recording', (ctx) => recordingView(db, scoped(ctx)));
  route('POST', '/api/governance/recording', (ctx) => setRecordingPolicy(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/recordings', (ctx) => listRecordings(db, scoped(ctx)));
  route('GET', '/api/calls/:id/recording', (ctx) => getRecording(db, scoped(ctx), ctx.params.id));

  // ---- value / operations card
  route('GET', '/api/insights/value', (ctx) => computeValue(db, scoped(ctx), Object.fromEntries(ctx.query)));
}
