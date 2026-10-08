import { useEffect, useRef, useState, type ReactNode } from 'react';

const STATUS_TEXT: Record<string, string> = {
  verified: 'Verified', reported: 'Reported', inferred: 'Inferred', missing: 'Missing', conflicting: 'Conflicting', stale: 'Stale',
};

export function StatusBadge({ status, onClick, label }: { status: string; onClick?: () => void; label?: string }) {
  const text = STATUS_TEXT[status] ?? status;
  const cls = `badge b-${STATUS_TEXT[status] ? status : 'neutral'}`;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label ?? `${text}: open source`}>{text}</button>;
  return <span className={cls}>{text}</span>;
}

const STATE_TONE: Record<string, [string, string]> = {
  ready: ['neutral', 'Not investigated'],
  needs_information: ['review', 'Evidence missing'],
  specialist_review: ['review', 'Specialist review'],
  blocked: ['danger', 'Blocked: identity'],
  awaiting_review: ['review', 'Review required'],
  approved: ['verified', 'Approved for submission'],
  executing: ['review', 'Dispatching'],
  awaiting_receipt: ['review', 'Request accepted, awaiting confirmation'],
  receipt_uncertain: ['danger', 'Receipt uncertain'],
  monitoring: ['verified', 'Monitoring follow-up'],
  resolved: ['verified', 'Resolved'],
  // action states
  rejected: ['neutral', 'Rejected'],
  needs_evidence: ['review', 'Evidence requested'],
  superseded: ['neutral', 'Superseded'],
  expired: ['neutral', 'Expired'],
  cancelled: ['neutral', 'Cancelled'],
  stale_blocked: ['danger', 'Blocked: stale approval'],
  dispatching: ['review', 'Dispatching'],
  uncertain: ['danger', 'Receipt uncertain'],
  accepted: ['verified', 'Submitted, request accepted'],
  confirmed: ['verified', 'Submitted, receipt confirmed'],
  pending: ['review', 'Queued for dispatch'],
  failed: ['danger', 'Failed: needs human'],
};

export function StateBadge({ state }: { state: string }) {
  const [tone, text] = STATE_TONE[state] ?? ['neutral', state];
  return <span className={`badge b-${tone === 'review' ? 'review' : tone}`}>{text}</span>;
}

export function Panel({ title, actions, children, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      {(title || actions) && <div className="row" style={{ marginBottom: 12 }}>{title && <h2 id={id}>{title}</h2>}{actions}</div>}
      {children}
    </section>
  );
}

export function Heading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: ReactNode }) {
  return <header><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{subtitle && <p className="subtitle">{subtitle}</p>}</header>;
}

let pushToast: ((msg: string, err?: boolean) => void) | null = null;
export function toast(msg: string, err = false) { pushToast?.(msg, err); }

export function Toaster() {
  const [t, setT] = useState<{ msg: string; err: boolean } | null>(null);
  useEffect(() => {
    pushToast = (msg, err = false) => setT({ msg, err });
    return () => { pushToast = null; };
  }, []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 6000);
    return () => clearTimeout(id);
  }, [t]);
  return t ? <div className={`toast${t.err ? ' err' : ''}`} role="status" aria-live="polite">{t.msg}</div> : null;
}

// Modal surface with focus return and Escape to close.
export function Overlay({ kind, label, onClose, children }: { kind: 'drawer' | 'dialog'; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <section ref={ref} tabIndex={-1} className={kind} role="dialog" aria-modal="true" aria-label={label}>{children}</section>
    </>
  );
}
