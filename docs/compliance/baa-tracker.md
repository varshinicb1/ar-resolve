# BAA tracker (DRAFT)

Status as of 2026-10-12. **No BAA has been signed with any vendor.** This is a working tracker,
not a compliance statement. In the running system the authoritative state is the vendor/BAA
register (`vendor_baas`, Integrations page), which the PHI gate reads.

Evidence tags: `[read 2026-10-12]` means the page was read during this build (URL given).
`status: unverified` means the statement comes from the origin project's tracker or from memory,
and must be verified with the vendor before anyone relies on it. A vendor page is the vendor's own
statement; the signed contract is what counts.

## Vendors AR Resolve would use

| Vendor id | Layer | Would see PHI? | BAA available? | Status |
|---|---|---|---|---|
| `availity` | connector (clearinghouse) | yes | status: unverified | Not signed |
| `optum` | connector (clearinghouse) | yes | status: unverified | Not signed |
| `epic` | connector (EHR/PM) | yes | status: unverified | Not signed |
| `athenahealth` | connector (EHR/PM) | yes | status: unverified | Not signed |
| `sftp_host` | connector (EDI file drop) | yes | depends on the host chosen | Not signed |
| `twilio` | call engine, staff SMS | yes | see below | Not signed |
| hosting provider | hosting | yes | none selected (`AR_HOSTING_VENDORS` unset) | Not selected |
| `slack`, `microsoft`, `resend` | notifications | only with the details opt-in | status: unverified | Not signed; channels send opaque ids only |
| GitHub, owner email | development | **must never hold PHI** | n/a | Never in scope |

No model vendor appears. Transcript and document extraction in this build is deterministic code
(`EXTRACTION_LAYER` in `server/services/governance.ts`), and no model receives text.

## Twilio

- `[read 2026-10-12]` Twilio's Conversation Relay page
  (https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) describes it as a HIPAA
  Eligible Service when configured properly. A BAA is required before PHI flows.
- `[read 2026-10-12]` https://www.twilio.com/en-us/hipaa is listed as a source on the
  `twilio_voice` connector (ADR 0030).
- These are `status: unverified`: which Twilio edition a BAA requires, and whether each speech
  provider choice inside Conversation Relay is covered. Ask Twilio in writing.

## How to record a BAA

1. File the executed agreement and note where it is filed (`baaRef`).
2. On the Integrations page (supervisor), record the vendor id, status `signed`, `baaRef`, the
   effective date, the covered services as listed in the agreement, and a reason.
3. The record is append-only and audited (`vendor_baa_recorded`). A change is a new version.
4. The PHI gate counts a vendor only when its latest record is `signed`, in effect and not
   expired.
