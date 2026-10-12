// Governance workstream routes (ADR 0070, ported from clinic-receptionist): PHI readiness, the
// vendor/BAA register, Guard profiles and per-account Guard findings, notification channels with
// their outbox and simulated sink, and the Twilio voice webhooks for the (refused) live adapter.
import type { ModuleApi, Ctx } from '../app.ts';
import { RawResponse } from '../app.ts';
import { AppError, notFound, nowIso, sha256 } from '../../util.ts';
import { requirePerm } from '../../services/auth.ts';
import { one, run } from '../../db/db.ts';
import { BAA_STATUSES, baaHistory, phiReadiness, recordBaa } from '../../services/governance.ts';
import { describeProfiles, guardTranscript, GUARD_VERSION } from '../../services/guard.ts';
import { listEvidence } from '../../services/evidence.ts';
import { catalog, createChannel, deliverDue, listChannels, listDeliveries, sinkMessages, testChannel, updateChannel } from '../../services/notifications.ts';
import { parseStatusCallback, relayDoneTwiml, signedUrlForms, verifyTwilio } from '../../connectors/telephony/twilio.ts';
import { audit } from '../../services/audit.ts';

const VENDOR_ID = /^[a-z0-9_.-]{2,40}$/;

/** Verify a Twilio webhook against the configured public URL. Unconfigured deployments answer 503. */
function verified(ctx: Ctx, path: string) {
  const base = (process.env.AR_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const token = process.env.AR_TWILIO_AUTH_TOKEN;
  const sig = ctx.req.headers['x-twilio-signature'];
  const v = verifyTwilio(base ? token : undefined, base ? signedUrlForms(`${base}${path}`) : [], Array.isArray(sig) ? sig[0] : sig, ctx.raw);
  if (!v.ok) throw new AppError(v.status, v.reason, v.reason === 'not_configured' ? 'Twilio webhooks are not configured in this deployment' : 'Twilio signature check failed');
  return v.params;
}

export function register(api: ModuleApi) {
  const { db, route, scoped } = api;
  const admin = (ctx: Ctx) => { const s = scoped(ctx); requirePerm(s, 'integration_admin'); return s; };

  // ---- PHI readiness and the vendor/BAA register
  route('GET', '/api/governance/readiness', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    return phiReadiness(db, s);
  });
  route('GET', '/api/governance/vendors', (ctx) => {
    const s = admin(ctx);
    const r = phiReadiness(db, s);
    return { statuses: BAA_STATUSES, vendors: r.vendors };
  });
  route('GET', '/api/governance/vendors/:vendorId/baa', (ctx) => {
    const s = admin(ctx);
    if (!VENDOR_ID.test(ctx.params.vendorId)) throw notFound('Vendor');
    return baaHistory(db, s, ctx.params.vendorId);
  });
  route('POST', '/api/governance/vendors/:vendorId/baa', (ctx) => recordBaa(db, admin(ctx), ctx.params.vendorId, ctx.body ?? {}));

  // ---- Guard
  route('GET', '/api/governance/guard', (ctx) => { const s = scoped(ctx); requirePerm(s, 'view'); return { version: GUARD_VERSION, profiles: describeProfiles() }; });
  route('GET', '/api/accounts/:id/guard-findings', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    if (!one(db, 'SELECT 1 FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', s.tenantId, s.clientId, ctx.params.id)) throw notFound('Account');
    // Findings are evidence warnings for a reviewer. They never change facts or proposed actions.
    return { version: GUARD_VERSION, transcripts: listEvidence(db, s, ctx.params.id).filter((e) => e.kind === 'call_transcript')
      .map((e) => ({ evidenceId: e.evidenceId, title: e.title, observedAt: e.observedAt, findings: guardTranscript(e.content) })) };
  });

  // ---- notifications
  route('GET', '/api/notifications/catalog', (ctx) => { admin(ctx); return catalog(); });
  route('GET', '/api/notifications/channels', (ctx) => listChannels(db, scoped(ctx)));
  route('POST', '/api/notifications/channels', (ctx) => createChannel(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/notifications/channels/:id', (ctx) => updateChannel(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/notifications/channels/:id/test', (ctx) => testChannel(db, scoped(ctx), ctx.params.id));
  route('GET', '/api/notifications/deliveries', (ctx) => listDeliveries(db, scoped(ctx), ctx.query.get('channelId')));
  route('GET', '/api/notifications/sink', (ctx) => sinkMessages(db, scoped(ctx)));
  route('POST', '/api/notifications/deliver', (ctx) => deliverDue(db, admin(ctx)));

  // ---- Twilio webhooks (no session; the X-Twilio-Signature authenticates). Live calls are refused
  // in this deployment, so these only record what arrives; they never change a call or an account.
  route('POST', '/api/webhooks/twilio/voice-status', (ctx) => {
    const params = verified(ctx, '/api/webhooks/twilio/voice-status');
    const e = parseStatusCallback(params);
    if (!e) throw new AppError(400, 'malformed', 'Not a recognisable call status callback');
    const call = one<{ tenant_id: string; client_id: string; call_id: string }>(db,
      "SELECT tenant_id, client_id, call_id FROM voice_calls WHERE adapter='live_telephony' AND provider_call_id=?", e.callSid);
    const res = run(db, 'INSERT INTO telephony_callbacks VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING',
      e.dedupeKey, 'live_telephony', e.callSid, e.status, e.sequenceNumber, call?.tenant_id ?? null, call?.client_id ?? null, call?.call_id ?? null, call ? 1 : 0, sha256(ctx.raw), nowIso());
    const duplicate = res === 0;
    if (call && !duplicate) {
      audit(db, { tenantId: call.tenant_id, clientId: call.client_id, actorId: 'system:twilio', objectType: 'voice_call', objectId: call.call_id, eventType: 'telephony_callback_received',
        details: { status: e.status, sequenceNumber: e.sequenceNumber, terminal: e.terminal } });
    }
    return { accepted: true, duplicate, matched: !!call };
  });
  route('POST', '/api/webhooks/twilio/relay-done', (ctx) => {
    const params = verified(ctx, '/api/webhooks/twilio/relay-done');
    return new RawResponse('text/xml; charset=utf-8', relayDoneTwiml(params, process.env.AR_SPECIALIST_LINE ?? null));
  });
}
