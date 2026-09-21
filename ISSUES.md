# Known issues

Last reviewed **21 September 2026**.

The README's [What works](README.md#what-works) table is the other half of this
page: everything there was verified with two-way audio on a live account.
Symptom-driven debugging is in
[docs/install.md → Troubleshooting](docs/install.md#troubleshooting).

---

## Platform defects this app works around

These are Vobiz-side. The app is built around them; none is a setup mistake.

### 1. A call cannot be routed into a registered WebRTC endpoint

`<Dial><User>` to a registered endpoint fails platform-side: Vobiz builds a
gateway URI it cannot itself parse and drops its own INVITE. Verified on other
accounts and against Vobiz's own SDK, and nothing configurable on this side
avoids it.

**Consequence:** inbound cannot ring the browser directly. The caller is parked
in a conference and the panel dials *out* to join them — which is why the flow
looks inverted in [the README](README.md#an-inbound-call-step-by-step).

### 2. `<Dial>` loses the media on roughly half of outbound calls

Measured on a live account: outbound with the browser bridged in by `<Dial>` was
silent on 3 of 5 calls, at 98–99% packet loss on the phone leg, while the
browser's own leg stayed clean at 1–3.5%. The same destination dialled by the
REST API with no browser leg was clean 3 of 3.

Signalling completed every time, so a failed call still rang, answered and
billed with nobody able to hear anything. `<Dial>` exposes no attribute that
controls media handling.

**Consequence:** outbound also uses a conference — the agent waits in a room and
the destination is dialled into it by the REST API. Both halves measured clean;
only their combination was not.

**If Vobiz fixes this**, the backend can revert to the simpler `<Dial>` path and
this app needs no change.

### 3. Two CDRs per call

A direct consequence of the conference on both directions: one CDR per leg, with
matching durations. They are the two halves of one conversation, not two calls.

### 4. A space in the SIP User-Agent makes Vobiz block its own INVITE

Keep it a single token. Costly to rediscover.

---

## Limitations of this app

- **A second caller while one is already ringing goes to voicemail.** One offer
  per agent at a time; there is no queue.
- **One agent per Call Center definition.** More agents need more definitions,
  each with its own `agentId`.
- **Only one Salesforce tab** may have the panel signed in. Several tabs
  register the same SIP identity and evict each other, so a call can ring a tab
  Vobiz will no longer reach.
- **Browser calling only.** No option to route a call to a mobile or desk phone.
  `/start-call` survives in the backend contract for anyone who wants to build
  that.
- **No hold, mute, transfer, or conference between agents.**
- **Calls are logged as Tasks**, not Voice Call records — those require Service
  Cloud Voice.
- **No omnichannel presence.** The panel does not set agent availability.
- **Recordings are not listed or played in the panel.** Deliberate: serving them
  would mean the calling backend hands call audio to whoever can reach it. Play
  them in the Vobiz Console.
- **SIP direct cannot enable inbound or list recordings.** Both are account-level
  operations that endpoint credentials do not authorise. Inbound still works on
  a number already routed.

---

## Things that bite during setup

- **A quick tunnel gets a new hostname every restart**, and Salesforce stores
  only a URL. A wildcard Trusted URL (`https://*.trycloudflare.com`) saves
  re-doing the Trusted URL step each time; production wants a stable hostname
  and a scoped entry.
- **Salesforce caches the adapter URL.** After changing it, hard-refresh
  (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) or you keep the old one.
- **A tunnel that shows a browser interstitial cannot work.** A frame cannot
  suppress it and Salesforce shows a blank panel. ngrok's free tier shows one;
  Cloudflare quick tunnels do not.
- **`frame-src` must be ticked** on the Trusted URL, or Salesforce refuses to
  frame the panel.

---

## What is not verified

- **No automated tests.** There is no build and no test suite; CI checks that the
  JavaScript parses and that documentation links resolve, nothing more. Every
  row in the README's status table was confirmed by hand.
- **The backend is out of scope.** This repository ships no backend, so nothing
  here can verify one. If you are implementing
  [docs/backend-contract.md](docs/backend-contract.md), its
  [security requirements](docs/backend-contract.md#security-requirements) are
  the part to read twice — the obvious implementation of the recording endpoint
  hands call audio to anyone who can reach it.
