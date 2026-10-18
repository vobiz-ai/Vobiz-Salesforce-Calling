# Security policy

## Reporting a vulnerability

Email **support@vobiz.ai** with the details. Please do not open a public issue
for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated on the fix.

## Scope

This repository contains the Salesforce panel and a reference calling backend
(`backend/`). It ships no credentials of its own.

It stores one thing in the browser, and only when the agent ticks **Remember**
on the SIP direct tab: that endpoint's username, password and caller ID, in
`localStorage` on their own machine. Untick it and nothing is written. Nothing
is stored on the account tab — the Auth Token is exchanged with the backend and
never kept in the browser. On the SIP direct tab the password goes only to the
Vobiz registrar; the backend is told the SIP username and caller ID.

The reference backend holds each signed-in account's Auth Token in memory only,
keyed by Auth ID, and never returns, logs or writes it. Nothing about a Vobiz
account is configured in its environment.

**Most of the attack surface of this integration lives in the calling backend**,
which is a separate service that you run and that holds your Vobiz Auth Token.
Its security requirements are documented in
[docs/backend-contract.md](docs/backend-contract.md#security-requirements), and
[backend/README.md](backend/README.md#security) explains how the reference
backend meets each one.

If you are implementing that backend, note in particular:

- `agentId` arrives from the browser as an unauthenticated, guessable string.
  Do not treat it as proof of identity.
- Do not serve long-lived SIP passwords from an open endpoint.
- Do not build an unauthenticated recording proxy. Sign recording URLs with a
  short expiry instead.
- Do not set `Access-Control-Allow-Origin: *`.

On the panel itself: the adapter URL's query string is untrusted, because anyone
can send an agent a link to the panel. So `?org=` must name a Salesforce host
and `?apiVersion=` must be a version number before the Open CTI toolkit is
loaded from them; and `?registrarUrl=` must be a Vobiz host. There is no
parameter for the backend's address: the panel only talks to the origin that
served it. If you fork this, keep
those checks — without them, a crafted link runs someone else's script on the
origin serving the panel, or sends what an agent types to someone else's
server. `tests/opencti-host.test.mjs` covers each one.

A backend that skips these exposes call recordings, allows calls to be billed to
your account, and allows your inbound number routing to be rewritten.
