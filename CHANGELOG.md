# Changelog

All notable changes to this app are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **The panel, ported from the Freshsales app.** Telephony is identical by
  design — the conference bridge, the ICE gathering cap, the
  placeholder-password gate and the caller release on hangup are not
  CRM-specific and should not be reimplemented per platform. Only the CRM layer
  differs. `tools/port-from-freshsales.mjs` regenerates it.
- **A host adapter** (`app/opencti-host.js`) presenting a Freshworks-shaped
  `client` backed by Salesforce Open CTI. It is the only Salesforce-specific
  code in the app.
- **Inbound calling.** The caller is parked in a conference and the panel polls
  for the offer, because Vobiz cannot deliver a call into a registered WebRTC
  endpoint. Accept, Decline, and keyboard shortcuts.
- **Outbound via a conference** rather than `<Dial>`, which loses the media
  about half the time — measured at 98–99% packet loss on the phone leg while
  the browser's own leg stayed clean.
- **Two ways to sign in.** Auth ID and Auth Token, or one endpoint's own SIP
  credentials. Calling is identical after either.
- **Screen-pop** on both directions, via `searchAndScreenPop`.
- **Call logging** as a completed Task, via `saveLog`, related to the matched
  record. Talk time, not ring time.
- **Per-call recording**, carried on the INVITE as a SIP header rather than
  stored anywhere.
- **Click-to-dial** across Salesforce, enabled by the app itself.
- **[ISSUES.md](ISSUES.md)** — the platform defects this app is built around,
  the limitations, and what is not verified. `docs/backend-contract.md` already
  linked to it.
- **[MARKETPLACE.md](MARKETPLACE.md)** — what an AppExchange listing would
  require, and why Open CTI needs none.
- **CI**, checking the things that rot silently here: that the JavaScript
  parses, that documentation links and heading anchors resolve
  (`tools/check-docs.mjs`), that the Call Center XML is well-formed, and that no
  credential and no removal of the `?org=` host check reaches `main`.

### Security
- **`?org=` is validated against Salesforce's own domains** before a script tag
  is created from it. It names the host the Open CTI toolkit is loaded from, so
  an unchecked value meant a link carrying someone else's `org=` could run their
  script on whichever origin serves the panel — the calling backend, in the
  recommended setup. The referrer-derived fallback had always checked the
  hostname; the explicit parameter had not.

### Changed
- The Open CTI toolkit is loaded at runtime from the `?org=` parameter instead
  of a hardcoded org URL, so this repository ships org-agnostic.
- JsSIP is vendored at `app/lib/jssip.min.js` so the app works on any static
  host rather than depending on a particular backend path.
