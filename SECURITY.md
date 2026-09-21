# Security policy

## Reporting a vulnerability

Email **support@vobiz.ai** with the details. Please do not open a public issue
for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated on the fix.

## Scope

This repository contains the Salesforce client app only. It ships no credentials
of its own.

It stores one thing in the browser, and only when the agent ticks **Remember**
on the SIP direct tab: that endpoint's username, password and caller ID, in
`localStorage` on their own machine. Untick it and nothing is written. Nothing
is stored on the account tab — the Auth Token is exchanged with the backend and
never kept.

**Most of the attack surface of this integration lives in the calling backend**,
which is a separate service that you run and that holds your Vobiz Auth Token.
Its security requirements are documented in
[docs/backend-contract.md](docs/backend-contract.md#security-requirements).

If you are implementing that backend, note in particular:

- `agentId` arrives from the browser as an unauthenticated, guessable string.
  Do not treat it as proof of identity.
- Do not serve long-lived SIP passwords from an open endpoint.
- Do not build an unauthenticated recording proxy. Sign recording URLs with a
  short expiry instead.
- Do not set `Access-Control-Allow-Origin: *`.

One note on the panel itself: `?org=` names the host the Open CTI toolkit is
loaded from, so it is checked against Salesforce's own domains before any script
tag is created. If you fork this, keep that check — without it, a link with
someone else's `org=` runs their script on whichever origin serves the panel,
which in the recommended setup is your calling backend.

A backend that skips these exposes call recordings, allows calls to be billed to
your account, and allows your inbound number routing to be rewritten.
