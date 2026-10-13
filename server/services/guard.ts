// Ported from clinic-receptionist src/guard.ts (same owner): a code-enforced Guard that runs on
// every turn independently of whatever produces the words. The origin guards a patient-facing
// receptionist; AR Resolve's agent talks to a payer representative, so the rule set is adapted:
//
//   inbound (representative turns, untrusted evidence)
//     prompt_injection, excessive_agency (verification/read-back bypass), memory_poisoning
//     ("from now on..."), identity_request (patient identifiers outside the script),
//     credential_request, payment_redirect (bank/remittance change requests)
//   outbound (agent utterances, checked BEFORE they are spoken)
//     phi_disclosure (SSN/DOB/card/email/phone/patient-token shapes, including spelled-out
//     read-backs), human_claim (the agent may never say it is a person), unearned_promise
//     (payment, write-off, waiver, approval), missing_disclosure (the opening must say the caller
//     is automated), unsourced_figure (an amount or date no source on this call or account gave)
//
// Inbound verdicts are warnings only: the turn is stored, flagged for reviewers and never changes
// an action, permission or state transition (transcripts are evidence, not instructions). An
// outbound verdict of "block" withholds the utterance; the engine then hands the call to a human.
// The origin's crisis / emergency rules are kept as the `clinical_safety` module, registered but
// disabled for the payer profile (no patient is on a payer call). Its clinical-advice, dental
// triage and scheduling-fabrication rules are not ported (patient-line only).
//
// Multilingual (ADR 0080, guard.v2): representative turns in Spanish or Portuguese are screened too.
// Ported from the origin: its accent folding (foldForScan) and its convention of writing es/pt
// patterns accent-free against folded text, plus its es/pt crisis and emergency rules (kept in the
// disabled clinical_safety module). The origin has no es/pt injection, identifier, credential or
// payment rules (its es/pt rules are clinical), so those were written here for AR and are marked
// `lang` on each rule. Over-triggering is the safe failure: inbound hits only flag.
// Outbound, spoken numbers are turned back into digits first (voice/spoken.ts), so identifier shapes
// and unsourced dates are caught when the agent says them in words.
import { Registry, type Pluggable } from '../core/registry.ts';
import { findDate, findMoney, isInstructionLike } from './voice/extract.ts';
import { digitWordsToDigits, spokenDatesToDigits } from './voice/spoken.ts';

export const GUARD_VERSION = 'guard.v2';

export type GuardMode =
  | 'prompt_injection' | 'excessive_agency' | 'memory_poisoning' | 'identity_request' | 'credential_request' | 'payment_redirect'
  | 'phi_disclosure' | 'human_claim' | 'unearned_promise' | 'missing_disclosure' | 'unsourced_figure' | 'crisis';
export type Severity = 'low' | 'medium' | 'high';

export interface RuleHit { ruleId: string; mode: GuardMode; severity: Severity; why: string; match: string }
export interface GuardVerdict { version: string; profile: string; direction: 'inbound' | 'outbound'; action: 'allow' | 'flag' | 'block'; modes: GuardMode[]; severity: Severity | 'none'; hits: RuleHit[] }

interface Rule { id: string; re?: RegExp; test?: (text: string) => boolean; mode: GuardMode; severity: Severity; why: string; lang?: 'es' | 'pt' }

/** Lowercase and strip accents so es/pt rules match "contraseña"/"contrasena" alike. Ported from the origin. */
export function foldForScan(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export interface GuardModule { id: string; direction: 'inbound' | 'outbound'; description: string; rules: Rule[] }

// ---------------------------------------------------------------- inbound modules

const INJECTION: GuardModule = { id: 'injection', direction: 'inbound', description: 'Text that tries to instruct the automated system', rules: [
  // Ported from the origin's INJECTION rules (the clinic discount/free-visit rules are dropped).
  { id: 'inj.override', re: /\bignore (all |any )?(the |your )?(previous|prior|above|earlier) (instructions?|rules?|prompts?|guidelines?|directions?)\b/i, mode: 'prompt_injection', severity: 'high', why: 'instruction override attempt' },
  { id: 'inj.disregard', re: /\bdisregard (your|the|all|any) (instructions?|rules?|training|programming|policies)\b/i, mode: 'prompt_injection', severity: 'high', why: 'instruction override attempt' },
  { id: 'inj.extract', re: /\b(reveal|show|print|repeat|output|tell me) (me )?(your|the) (system )?(prompt|instructions?|rules?|directives?)\b/i, mode: 'prompt_injection', severity: 'high', why: 'system prompt extraction' },
  { id: 'inj.role', re: /\byou are (now |actually )?(a|an|no longer|in)\b[^.?!]{0,24}\b(ai|assistant|bot|admin|root|hacker|developer|dan|mode)\b/i, mode: 'prompt_injection', severity: 'high', why: 'role reassignment' },
  { id: 'inj.mode', re: /\b(developer|debug|god|admin) mode\b|\bjailbreak\b|\bnew (rules?|instructions?)\b/i, mode: 'prompt_injection', severity: 'high', why: 'mode-switch injection' },
  { id: 'inj.bypass', re: /\b(override|bypass|disable|turn off) (the |your )?(guard|policy|safety|restriction|rule|filter|review)\b/i, mode: 'prompt_injection', severity: 'high', why: 'guard bypass attempt' },
  { id: 'inj.constraint', re: /\byou (don'?t|do not|can'?t) have (to|any) (rules?|limits?|restrictions?)\b/i, mode: 'prompt_injection', severity: 'high', why: 'constraint negation' },
  { id: 'inj.addressed', re: /\b(note to|message for|attention) (the )?(automated|ai|system|bot)\b|^\s*system\s*:/i, mode: 'prompt_injection', severity: 'high', why: 'text addressed to the automated system' },
  // AR's own instruction-like detector (server/services/voice/extract.ts) as one rule.
  { id: 'inj.ar_instruction', test: isInstructionLike, mode: 'prompt_injection', severity: 'high', why: 'instruction-like text (approve, write off, grant access, mark paid)' },
  // Spanish / Portuguese (written for AR; scanned on folded text)
  { id: 'inj.es.override', lang: 'es', re: /\b(ignora|ignore|olvida|olvide) (todas |todo )?(las |tus |sus )?(instrucciones|reglas|indicaciones)( anteriores| previas)?\b/, mode: 'prompt_injection', severity: 'high', why: 'instruction override attempt (es)' },
  { id: 'inj.pt.override', lang: 'pt', re: /\b(ignore|ignora|esqueca|esquece) (todas |tudo )?(as |suas )?(instrucoes|regras|orientacoes)( anteriores| previas)?\b/, mode: 'prompt_injection', severity: 'high', why: 'instruction override attempt (pt)' },
  { id: 'inj.es.extract', lang: 'es', re: /\b(revela|muestra|repite|dime|imprime) (tus|las|sus) (instrucciones|reglas|indicaciones)\b|\bprompt del sistema\b/, mode: 'prompt_injection', severity: 'high', why: 'system prompt extraction (es)' },
  { id: 'inj.pt.extract', lang: 'pt', re: /\b(revele|mostre|repita|diga|imprima) (suas|as) (instrucoes|regras|orientacoes)\b|\bprompt do sistema\b/, mode: 'prompt_injection', severity: 'high', why: 'system prompt extraction (pt)' },
  { id: 'inj.es.mode', lang: 'es', re: /\bmodo (desarrollador|administrador|depuracion|dios)\b|\bnuevas (instrucciones|reglas)\b/, mode: 'prompt_injection', severity: 'high', why: 'mode-switch injection (es)' },
  { id: 'inj.pt.mode', lang: 'pt', re: /\bmodo (desenvolvedor|administrador|depuracao|deus)\b|\bnovas (instrucoes|regras)\b/, mode: 'prompt_injection', severity: 'high', why: 'mode-switch injection (pt)' },
  { id: 'inj.es.bypass', lang: 'es', re: /\b(desactiva|desactivar|omite|omitir|saltate|evita) (el |la |los |las )?(filtro|guardia|politica|revision|verificacion|seguridad|restriccion)(es)?\b/, mode: 'prompt_injection', severity: 'high', why: 'guard bypass attempt (es)' },
  { id: 'inj.pt.bypass', lang: 'pt', re: /\b(desative|desativar|ignore|pule|contorne) (o |a |os |as )?(filtro|guarda|politica|revisao|verificacao|seguranca|restricao)(s|es)?\b/, mode: 'prompt_injection', severity: 'high', why: 'guard bypass attempt (pt)' },
  { id: 'inj.es.ar_instruction', lang: 'es', re: /\b(aprueba|aprobar|autoriza|autorizar|condona|cancela|anula)( usted)? (el |la |los |las )?(ajuste|castigo|condonacion|cancelacion de (la )?deuda|saldo|pago|reembolso|cuenta)\b|\bmarca(r)? (la |el |esta |este )?(cuenta|reclamacion|reclamo|factura) como pagad[ao]\b/, mode: 'prompt_injection', severity: 'high', why: 'instruction-like text: approve, write off, mark paid (es)' },
  { id: 'inj.pt.ar_instruction', lang: 'pt', re: /\b(aprove|aprovar|autorize|autorizar|perdoe|cancele|anule) (o |a |os |as )?(ajuste|baixa|perdao da divida|saldo|pagamento|reembolso|conta)\b|\bmarque (a |o |esta |este )?(conta|sinistro|reclamacao|fatura) como pag[ao]\b/, mode: 'prompt_injection', severity: 'high', why: 'instruction-like text: approve, write off, mark paid (pt)' },
  { id: 'inj.es.addressed', lang: 'es', re: /\b(nota|mensaje|instruccion) para el (sistema|asistente|bot|automatizado)\b|^\s*sistema\s*:/, mode: 'prompt_injection', severity: 'high', why: 'text addressed to the automated system (es)' },
  { id: 'inj.pt.addressed', lang: 'pt', re: /\b(nota|mensagem|instrucao) para o (sistema|assistente|bot|automatizado)\b|^\s*sistema\s*:/, mode: 'prompt_injection', severity: 'high', why: 'text addressed to the automated system (pt)' },
] };

const AGENCY: GuardModule = { id: 'agency', direction: 'inbound', description: 'Requests to skip verification, confirmation or read-back', rules: [
  { id: 'agy.no_confirm', re: /\b(no need|don'?t need|do not need|you don'?t have) to (confirm|verify|check|ask|read (it|that|anything) back)\b/i, mode: 'excessive_agency', severity: 'medium', why: 'verification or read-back bypass' },
  { id: 'agy.skip', re: /\b(skip|bypass|skip past) (the )?(verification|confirmation|identity check|read[- ]?back)\b/i, mode: 'excessive_agency', severity: 'medium', why: 'verification or read-back bypass' },
  { id: 'agy.just_do', re: /\bjust (approve|submit|process|close|post|write) (it|this|that)\b/i, mode: 'excessive_agency', severity: 'medium', why: 'request to act without review' },
  { id: 'agy.es.skip', lang: 'es', re: /\bno (hace falta|es necesario|necesita|tiene que) (confirmar|verificar|leer|repetir)\b|\b(salta|omite|saltate) (la )?(verificacion|confirmacion|lectura)\b/, mode: 'excessive_agency', severity: 'medium', why: 'verification or read-back bypass (es)' },
  { id: 'agy.pt.skip', lang: 'pt', re: /\bnao (precisa|e necessario|tem que) (confirmar|verificar|ler|repetir)\b|\b(pule|ignore) (a )?(verificacao|confirmacao|leitura)\b/, mode: 'excessive_agency', severity: 'medium', why: 'verification or read-back bypass (pt)' },
] };

const MEMORY: GuardModule = { id: 'memory', direction: 'inbound', description: 'Attempts to set standing behaviour across calls', rules: [
  { id: 'mem.from_now', re: /\bfrom now on,? (always|never|you should|i want|skip|just)\b/i, mode: 'memory_poisoning', severity: 'medium', why: 'cross-call instruction' },
  { id: 'mem.remember', re: /\b(remember|save|store|note) (that )?(you should|to always|to never|for next time)\b/i, mode: 'memory_poisoning', severity: 'medium', why: 'persistent instruction' },
  { id: 'mem.always_never', re: /\b(always|never) (call|ask|verify|read back|confirm) (us|me|this line)\b/i, mode: 'memory_poisoning', severity: 'medium', why: 'cross-call instruction' },
  { id: 'mem.es.from_now', lang: 'es', re: /\b(de ahora en adelante|a partir de ahora),? (siempre|nunca|debe|omita)\b/, mode: 'memory_poisoning', severity: 'medium', why: 'cross-call instruction (es)' },
  { id: 'mem.pt.from_now', lang: 'pt', re: /\b(de agora em diante|a partir de agora),? (sempre|nunca|deve|pule)\b/, mode: 'memory_poisoning', severity: 'medium', why: 'cross-call instruction (pt)' },
] };

const IDENTITY: GuardModule = { id: 'identity', direction: 'inbound', description: 'Requests for patient identifiers outside the approved script (docs/08)', rules: [
  { id: 'idr.dob', re: /\b(date of birth|dob|birth ?date)\b/i, mode: 'identity_request', severity: 'high', why: 'date of birth requested' },
  { id: 'idr.ssn', re: /\b(social security|ssn)\b/i, mode: 'identity_request', severity: 'high', why: 'social security number requested' },
  { id: 'idr.address', re: /\b(home|mailing|patient'?s?) address\b/i, mode: 'identity_request', severity: 'high', why: 'patient address requested' },
  { id: 'idr.name', re: /\b(patient'?s?|member'?s?|subscriber'?s?) (full )?name\b|\bfull name\b/i, mode: 'identity_request', severity: 'high', why: 'patient name requested' },
  { id: 'idr.es.dob', lang: 'es', re: /\bfecha de nacimiento\b/, mode: 'identity_request', severity: 'high', why: 'date of birth requested (es)' },
  { id: 'idr.pt.dob', lang: 'pt', re: /\bdata de nascimento\b/, mode: 'identity_request', severity: 'high', why: 'date of birth requested (pt)' },
  { id: 'idr.es.ssn', lang: 'es', re: /\b(numero de )?seguro social\b/, mode: 'identity_request', severity: 'high', why: 'social security number requested (es)' },
  { id: 'idr.pt.ssn', lang: 'pt', re: /\b(numero do )?seguro social\b|\bcpf\b/, mode: 'identity_request', severity: 'high', why: 'social security or tax id requested (pt)' },
  { id: 'idr.es.address', lang: 'es', re: /\bdireccion (del paciente|de casa|postal|del domicilio|particular)\b|\bdomicilio del paciente\b/, mode: 'identity_request', severity: 'high', why: 'patient address requested (es)' },
  { id: 'idr.pt.address', lang: 'pt', re: /\bendereco (do paciente|residencial|de casa|postal)\b/, mode: 'identity_request', severity: 'high', why: 'patient address requested (pt)' },
  { id: 'idr.es.name', lang: 'es', re: /\bnombre completo\b|\bnombre del (paciente|asegurado|afiliado)\b/, mode: 'identity_request', severity: 'high', why: 'patient name requested (es)' },
  { id: 'idr.pt.name', lang: 'pt', re: /\bnome completo\b|\bnome do (paciente|segurado|beneficiario)\b/, mode: 'identity_request', severity: 'high', why: 'patient name requested (pt)' },
] };

const CREDENTIAL: GuardModule = { id: 'credential', direction: 'inbound', description: 'Requests for credentials or secrets', rules: [
  { id: 'crd.secret', re: /\b(password|passcode|pin( number)?|one[- ]time (code|password)|verification code|api key|access token|login|username|portal credentials?)\b/i, mode: 'credential_request', severity: 'high', why: 'credential requested' },
  { id: 'crd.es.secret', lang: 'es', re: /\b(contrasena|clave de acceso|codigo de verificacion|codigo de un solo uso|token de acceso|usuario y contrasena|credenciales del portal)\b/, mode: 'credential_request', severity: 'high', why: 'credential requested (es)' },
  { id: 'crd.pt.secret', lang: 'pt', re: /\b(senha|codigo de verificacao|codigo de uso unico|token de acesso|usuario e senha|credenciais do portal)\b/, mode: 'credential_request', severity: 'high', why: 'credential requested (pt)' },
] };

const PAYMENT: GuardModule = { id: 'payment_redirect', direction: 'inbound', description: 'Requests to change where money goes', rules: [
  { id: 'pay.change', re: /\b(change|update|switch|send|redirect)\b[^.?!]{0,30}\b(bank|routing|account number|eft|remittance address|payment (address|details|information|account)|wire)\b/i, mode: 'payment_redirect', severity: 'high', why: 'payment destination change requested' },
  { id: 'pay.es.change', lang: 'es', re: /\b(cambiar|cambie|actualizar|actualice|enviar|envie|redirigir|redirija)\b[^.?!]{0,30}\b(cuenta bancaria|numero de cuenta|numero de ruta|transferencia|direccion de (pago|remesa))\b/, mode: 'payment_redirect', severity: 'high', why: 'payment destination change requested (es)' },
  { id: 'pay.pt.change', lang: 'pt', re: /\b(mudar|mude|alterar|altere|atualizar|atualize|enviar|envie|redirecionar|redirecione)\b[^.?!]{0,30}\b(conta bancaria|numero da conta|transferencia|endereco de pagamento|pix)\b/, mode: 'payment_redirect', severity: 'high', why: 'payment destination change requested (pt)' },
] };

// Kept from the origin as a disabled module: crisis and emergency language (English only).
const CLINICAL_SAFETY: GuardModule = { id: 'clinical_safety', direction: 'inbound', description: 'Crisis and medical-emergency language (patient lines only; disabled for payer calls)', rules: [
  { id: 'cs.self_harm', re: /\b(kill myself|end my life|take my own life|suicid\w*|self[\s-]?harm|hurt myself)\b/i, mode: 'crisis', severity: 'high', why: 'suicidal ideation or self-harm language' },
  { id: 'cs.emergency', re: /\b(chest pains?|heart attack|having a stroke|not breathing|stopped breathing|unconscious|seizure|anaphyla\w*)\b/i, mode: 'crisis', severity: 'high', why: 'possible medical emergency' },
  // Ported unchanged from the origin's CRISIS_ES_PT and EMERGENCY_ES_PT (folded text).
  { id: 'cs.es.self_harm', lang: 'es', re: /\b(quiero morir\w*|no quiero (seguir )?vivir|matarme|quitarme la vida|suicid\w*|hacerme dano|lastimarme)\b/, mode: 'crisis', severity: 'high', why: 'suicidal ideation (es)' },
  { id: 'cs.pt.self_harm', lang: 'pt', re: /\b(quero morrer|nao quero (mais )?viver|me matar|tirar (a )?minha (propria )?vida|me machucar)\b/, mode: 'crisis', severity: 'high', why: 'suicidal ideation (pt)' },
  { id: 'cs.es.emergency', lang: 'es', re: /\b(dolor (en el|de|del) pecho|no puedo respirar|me falta el aire|infarto|ataque al corazon|derrame cerebral|se desmayo|me desmaye|inconsciente|convulsi\w*|reaccion alergica|no (para|deja) de sangrar|se me cierra la garganta)\b/, mode: 'crisis', severity: 'high', why: 'medical emergency (es)' },
  { id: 'cs.pt.emergency', lang: 'pt', re: /\b(dor no peito|nao consigo respirar|falta de ar|infarto|ataque cardiaco|derrame|avc|desmai\w*|inconsciente|convuls\w*|reacao alergica|nao para de sangrar|garganta (esta )?fechando)\b/, mode: 'crisis', severity: 'high', why: 'medical emergency (pt)' },
] };

// ---------------------------------------------------------------- outbound modules

const PHI_OUT: GuardModule = { id: 'phi_output', direction: 'outbound', description: 'Patient identifiers in what the agent says', rules: [
  { id: 'phi.ssn', re: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/, mode: 'phi_disclosure', severity: 'high', why: 'SSN-shaped number' },
  { id: 'phi.dob', re: /\b(date of birth|dob|birthday|born)\b/i, mode: 'phi_disclosure', severity: 'high', why: 'date of birth stated' },
  { id: 'phi.es_pt.dob', lang: 'es', re: /\b(fecha de nacimiento|data de nascimento|nacid[oa] el|nascid[oa] em)\b/, mode: 'phi_disclosure', severity: 'high', why: 'date of birth stated (es/pt)' },
  { id: 'phi.card', re: /\b(?:\d[ -]?){13,19}\b/, mode: 'phi_disclosure', severity: 'high', why: 'card-number-shaped digits' },
  { id: 'phi.email', re: /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i, mode: 'phi_disclosure', severity: 'high', why: 'email address' },
  { id: 'phi.phone', re: /(\+1[ -]?)?\(?\b\d{3}\)?[ -]\d{3}-\d{4}\b/, mode: 'phi_disclosure', severity: 'high', why: 'phone number' },
  { id: 'phi.patient_token', re: /\bPT-[A-Z0-9]{3,}\b/, mode: 'phi_disclosure', severity: 'high', why: 'patient token (member identifier) stated' },
] };

const HUMAN_CLAIM: GuardModule = { id: 'identity_disclosure', direction: 'outbound', description: 'The agent must never claim to be a person', rules: [
  { id: 'hum.claim', re: /\b(i am|i'm) (a )?(real |actual )?(human|person|live person|real person|not a (robot|bot|machine|computer))\b/i, mode: 'human_claim', severity: 'high', why: 'agent claimed to be human' },
  { id: 'hum.deny_ai', re: /\b(i am|i'm) not (an? )?(ai|automated|assistant|bot|robot)\b/i, mode: 'human_claim', severity: 'high', why: 'agent denied being automated' },
] };

const PROMISE: GuardModule = { id: 'promise', direction: 'outbound', description: 'Commitments the agent is not authorized to make', rules: [
  // Ported from the origin's AGENT_PROMISE, adapted from discounts to AR commitments.
  { id: 'prm.pay', re: /\b(we|i) (will|'ll|can) (pay|refund|write[- ]?off|waive|forgive|adjust off)\b/i, mode: 'unearned_promise', severity: 'high', why: 'payment or write-off commitment' },
  { id: 'prm.approve', re: /\b(i|we) (approve|authorize|accept responsibility|agree to (pay|write))\b/i, mode: 'unearned_promise', severity: 'high', why: 'approval stated on a call' },
  { id: 'prm.covered', re: /\bthat'?s (definitely|certainly) (covered|payable)\b/i, mode: 'unearned_promise', severity: 'high', why: 'coverage asserted' },
] };

/**
 * Normalizes spelled read-backs ("1 2 3 dash 4 5 dash 6 7 8 9", or the same in words: "one two three,
 * dash, four five ...") so shape rules see "123-45-6789".
 */
export function normalizeSpoken(text: string): string {
  return digitWordsToDigits(text).replace(/,?\s+dash,?\s+/gi, ' dash ').replace(/\s+dash\s+/gi, '-').replace(/(\d)\s+(?=\d)/g, '$1').replace(/(\d)\s*-\s*(?=\d)/g, '$1-');
}

const ALL_MODULES = [INJECTION, AGENCY, MEMORY, IDENTITY, CREDENTIAL, PAYMENT, CLINICAL_SAFETY, PHI_OUT, HUMAN_CLAIM, PROMISE];
export const GUARD_MODULES: Record<string, GuardModule> = Object.fromEntries(ALL_MODULES.map((m) => [m.id, m]));

// ---------------------------------------------------------------- profiles

export interface GuardProfile extends Pluggable {
  modules: Record<string, boolean>;
  /** The opening utterance (intent "disclose") must say the caller is automated. */
  requireAutomationDisclosure: boolean;
  /** Amounts and dates the agent states must come from the account or this call. */
  checkSourcedFigures: boolean;
}

export const GUARD_PROFILES = new Registry<GuardProfile>('guard profile', ['payer_rep']);

GUARD_PROFILES.register({
  id: 'payer_rep', label: 'AR agent calling a payer representative',
  modules: { injection: true, agency: true, memory: true, identity: true, credential: true, payment_redirect: true, clinical_safety: false, phi_output: true, identity_disclosure: true, promise: true },
  requireAutomationDisclosure: true, checkSourcedFigures: true,
});

GUARD_PROFILES.register({
  id: 'patient_line', label: 'Patient-facing line (origin profile; not used by AR Resolve)',
  modules: { injection: true, agency: true, memory: true, identity: false, credential: true, payment_redirect: true, clinical_safety: true, phi_output: true, identity_disclosure: true, promise: true },
  requireAutomationDisclosure: true, checkSourcedFigures: false,
  available: () => false,
});

export interface OutboundContext {
  /** Amounts (cents) that a source gave: the representative on this call, the account. */
  sourcedCents?: Set<number>;
  /** ISO dates that a source gave. */
  sourcedDates?: Set<string>;
  /** What the utterance is for; "disclose" is the opening. */
  intent?: string;
}

function hitsOf(profile: GuardProfile, direction: 'inbound' | 'outbound', text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  let folded: string | undefined;
  for (const m of ALL_MODULES) {
    if (m.direction !== direction || !profile.modules[m.id]) continue;
    for (const r of m.rules) {
      const target = r.lang ? (folded ??= foldForScan(text)) : text;
      const m = r.re ? r.re.exec(target) : r.test?.(target) ? [target] : null;
      if (!m) continue;
      const match = m[0] ?? '';
      hits.push({ ruleId: r.id, mode: r.mode, severity: r.severity, why: r.why, match: match.slice(0, 80) });
    }
  }
  return hits;
}

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
function verdict(profile: string, direction: 'inbound' | 'outbound', hits: RuleHit[], block: boolean): GuardVerdict {
  const top = hits.reduce<Severity | 'none'>((s, h) => (s === 'none' || RANK[h.severity] > RANK[s] ? h.severity : s), 'none');
  return { version: GUARD_VERSION, profile, direction, action: !hits.length ? 'allow' : block ? 'block' : 'flag', modes: [...new Set(hits.map((h) => h.mode))], severity: top, hits };
}

/** Representative turn. Never blocks: the text is stored as evidence and flagged. */
export function guardInbound(text: string, profileId = 'payer_rep'): GuardVerdict {
  const p = GUARD_PROFILES.require(profileId);
  return verdict(p.id, 'inbound', hitsOf(p, 'inbound', text), false);
}

/** Agent utterance, before it is spoken. High-severity hits block it. */
export function guardOutbound(text: string, ctx: OutboundContext = {}, profileId = 'payer_rep'): GuardVerdict {
  const p = GUARD_PROFILES.require(profileId);
  const spoken = normalizeSpoken(text);
  const hits = hitsOf(p, 'outbound', spoken);
  if (p.requireAutomationDisclosure && ctx.intent === 'disclose' && !/\b(automated|artificial intelligence|an ai\b|ai assistant|virtual assistant|bot)\b/i.test(text)) {
    hits.push({ ruleId: 'dis.automation', mode: 'missing_disclosure', severity: 'high', why: 'opening does not say the caller is automated', match: '' });
  }
  if (p.checkSourcedFigures) {
    for (const m of findMoney(text)) if (!ctx.sourcedCents?.has(m.cents)) hits.push({ ruleId: 'src.amount', mode: 'unsourced_figure', severity: 'medium', why: 'amount not given by any source on this call or account', match: m.text });
    const d = findDate(text) ?? findDate(spokenDatesToDigits(text)); // dates said in words, as read-back now does
    if (d?.iso && !ctx.sourcedDates?.has(d.iso)) hits.push({ ruleId: 'src.date', mode: 'unsourced_figure', severity: 'medium', why: 'date not given by any source on this call or account', match: d.partial });
  }
  return verdict(p.id, 'outbound', hits, hits.some((h) => h.severity === 'high'));
}

/** Scan a stored transcript (any call_transcript evidence, including the legacy pre-scripted calls). Read-only. */
export function guardTranscript(content: unknown): { turn: number | null; speaker: string; verdict: GuardVerdict }[] {
  const turns = (content as { turns?: { turn?: number; speaker?: string; text?: string }[] } | null)?.turns ?? [];
  const out: { turn: number | null; speaker: string; verdict: GuardVerdict }[] = [];
  for (const t of turns) {
    const speaker = String(t.speaker ?? '');
    const text = String(t.text ?? '');
    if (!text) continue;
    const v = speaker === 'agent' ? guardOutbound(text, { sourcedCents: undefined }, 'payer_rep') : speaker === 'rep' || speaker === 'payer' || speaker === 'representative' ? guardInbound(text) : null;
    if (!v) continue;
    // Stored transcripts have no per-turn source context, so unsourced-figure checks are not meaningful here.
    const hits = v.hits.filter((h) => h.mode !== 'unsourced_figure' && h.mode !== 'missing_disclosure');
    if (hits.length) out.push({ turn: typeof t.turn === 'number' ? t.turn : null, speaker, verdict: { ...v, hits, modes: [...new Set(hits.map((h) => h.mode))] } });
  }
  return out;
}

export function describeProfiles() {
  return GUARD_PROFILES.list().map((p) => ({ id: p.id, label: p.label, active: !p.available || p.available({}),
    modules: Object.entries(p.modules).map(([id, enabled]) => ({ id, enabled, direction: GUARD_MODULES[id]?.direction, description: GUARD_MODULES[id]?.description, rules: GUARD_MODULES[id]?.rules.map((r) => r.id) ?? [] })),
    requireAutomationDisclosure: p.requireAutomationDisclosure, checkSourcedFigures: p.checkSourcedFigures }));
}
