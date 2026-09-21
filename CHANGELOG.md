# Changelog

Notable changes to this app. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0]

First public release.

### Features
- **Outbound calling** from the panel, with two-way audio in the browser.
- **Inbound calling**, with accept, decline, and keyboard shortcuts.
- **Click-to-dial** on phone numbers across Salesforce.
- **Screen-pop** of the matching record on both directions.
- **Call logging** as a completed Task, related to the matched record, recording
  talk time rather than ring time.
- **Per-call recording**, requested per call and played back in the Vobiz
  Console.
- **Two ways to sign in** — Vobiz account credentials, or a single SIP
  endpoint's own credentials. Calling is identical after either.

### Notes
- Both call directions use a conference room rather than a direct bridge, which
  is what keeps browser audio reliable. It produces two CDRs per call.
- The Open CTI toolkit is loaded from the org named by the `?org=` parameter,
  which is validated against Salesforce's own domains, so the app ships
  org-agnostic and the panel's origin stays safe.
- JsSIP is vendored at `app/lib/jssip.min.js`, so the app runs on any static
  host.
