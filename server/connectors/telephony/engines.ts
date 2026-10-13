// Ported from clinic-receptionist src/engines.ts and the CallEngine contract in src/core/ports.ts
// (same owner). A call engine is how a payer call's audio and text reach the agent.
//
// Adapted for AR Resolve: there is no WebSocket handler here (the step engine in
// server/services/voice/engine.ts drives calls), so an engine is a descriptor: its vendors (for the
// PHI gate), whether the code Guard sees every agent utterance before it is spoken, and whether it is
// live. Which engines are enabled is deployment configuration (AR_CALL_ENGINES, default sim_voice).
import { Registry, type DataProcessor, type Pluggable, type Settings } from '../../core/registry.ts';

export interface CallEngine extends Pluggable, DataProcessor {
  /** Does this engine run the code Guard on every agent utterance before it is spoken? */
  readonly guarded: boolean;
  /** Places real calls through an outside provider. */
  readonly live: boolean;
  /** The VoiceAdapter name the step engine uses for calls on this engine. */
  readonly adapter: string;
}

export const CALL_ENGINES = new Registry<CallEngine>('engine', ['sim_voice']);

CALL_ENGINES.register({
  id: 'sim_voice',
  label: 'Simulated payer line (scripted IVR, hold and representative; no telephony, speech or model)',
  vendors: [],
  guarded: true,
  live: false,
  adapter: 'sim_voice',
});

CALL_ENGINES.register({
  id: 'twilio_relay',
  label: 'Twilio Programmable Voice + Conversation Relay (speech-to-text, agent text, text-to-speech)',
  // Twilio carries the audio and runs speech recognition and synthesis. The speech providers it
  // uses inside Conversation Relay are Twilio subprocessors; their coverage must be confirmed with
  // Twilio in writing (docs/compliance/baa-tracker.md).
  vendors: ['twilio'],
  // Agent text passes the Guard before it is sent to the socket; the provider speaks only that text.
  guarded: true,
  live: true,
  adapter: 'live_telephony',
  available: (s: Settings) => !!s.AR_TWILIO_ACCOUNT_SID && !!s.AR_TWILIO_AUTH_TOKEN,
});

/** Engines enabled for this deployment (AR_CALL_ENGINES, comma list; unknown ids ignored). */
export function enabledEngines(settings: Settings = process.env): CallEngine[] {
  return CALL_ENGINES.order(settings.AR_CALL_ENGINES ?? 'sim_voice');
}
