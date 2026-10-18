# Changelog

Notable changes to this app. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Outbound talk time no longer includes ring time.** The backend records when
  the destination answers and reports it on a new `GET /call-state`; the panel
  logs from that moment, and an unanswered call as 0 seconds, *No answer*.
- **SIP direct inbound calls pop the caller's record and are logged as a
  Task** (answered, missed or declined). The backend's `<Dial><User>` carries
  the caller's number as `callerName`, and `/call-state` reports it as well.
- The panel's FAQ said Vobiz dials the customer first. The browser calls first
  and the destination is dialled into its room.

### Removed
- The `?backendUrl=` adapter parameter. The panel's requests are same-origin
  cookie-authenticated JSON, so a backend on another origin could never answer
  them; the panel now always talks to the origin that served it.

### Changed
- **Any Vobiz account can sign in.** The reference backend has no account of
  its own: `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` and `SIP_DIRECT_USERNAMES` are
  gone. Several accounts can be signed in at once; sessions, endpoints and
  call routing are keyed by account and agent together.
- Provisioning is one `VobizSF` application per account, found by answer URL
  (never repointing anyone else's), and one endpoint per agent, recorded in
  `backend/data/endpoints.json` (ids and usernames only) and bound with a
  string `app_id`, verified by reading it back. 17-digit ids are never turned
  into JavaScript numbers.
- Inbound calls are routed by the webhook's `ParentAuthID`, or the dialled
  number, and ring every open panel of that account.
- The caller ID dropdown lists every page of the account's active,
  voice-enabled numbers and shows the application each is on.
- **SIP direct** works with no backend credentials: outbound by `<Dial>`,
  inbound by `<Dial><User>` to the endpoint, once the endpoint and number are
  attached to an application pointing at the backend.

## [1.1.0]

### Added
- **A reference calling backend** in `backend/`: one dependency-free Node.js
  file that implements the whole backend contract, serves the panel, and meets
  the contract's security requirements. The panel no longer needs a backend
  written before the first call.
- **A test suite** (`npm test`), run in CI.

### Fixed
- **Screen-pop now happens when the call starts.** It used to run only after
  the call ended. An inbound caller's record opens while the panel rings; a
  click-to-dial keeps the record that was clicked.
- **Calls matched to an Account are logged.** The Task put every match in
  `WhoId`, which Salesforce rejects for anything but a Contact or Lead.
- **`?apiVersion=`, `?backendUrl=` and `?registrarUrl=` are validated**, like
  `?org=` already was. A crafted `apiVersion` could load a script from any path
  on a Salesforce host; a crafted `backendUrl` or `registrarUrl` could send what
  an agent typed to another server.
- Leftover names from the panel this was ported from: the SIP User-Agent, the
  `platform` sent to `/setup-inbound`, and the dial step's help text.

### Changed
- `docs/backend-contract.md` drops endpoints the panel never calls
  (`/start-call`, `/call-status`, `/recordings`, `/recording-audio`), and its
  security requirements now match what the panel can actually do.

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
