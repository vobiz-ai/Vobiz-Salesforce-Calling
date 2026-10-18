# Reference calling backend

A complete implementation of [the backend contract](../docs/backend-contract.md),
so the panel can make and take real calls without you writing a backend first.
One file, no dependencies, Node 20.12 or later.

It also **serves the panel** at `/salesforce/softphone.html`. That is the
recommended setup: one hostname to keep alive, and the panel's requests to the
backend are same-origin, so there is no CORS to configure.

## Run it

```bash
cp backend/.env.example backend/.env    # then set PUBLIC_BASE_URL
node backend/server.js                  # or: npm start
```

`PUBLIC_BASE_URL` is the public `https://` address Vobiz and Salesforce reach
this server at. Locally that is a tunnel to the port:

```bash
cloudflared tunnel --url http://localhost:8080
```

Use a tunnel that does **not** show a browser warning page — a frame cannot
click through one, and Salesforce shows a blank panel. Cloudflare quick tunnels
do not show one; ngrok's free tier does.

Then set the Call Center's adapter URL to:

```
https://<PUBLIC_BASE_URL host>/salesforce/softphone.html?org=https://<your-org>.my.salesforce.com&agentId=<agent>
```

## Any Vobiz account can sign in

Nothing about a Vobiz account is configured on the server. There is no Auth ID,
Auth Token, SIP username, password, caller ID, endpoint id or application id in
`.env` — each agent signs in from the panel, and two agents on two different
Vobiz accounts can be signed in to the same backend at once. Everything the
backend keeps is keyed by **account and agent together** (`<authId>:<agentId>`),
so the same `agentId` in two accounts never collides.

## What it does with your Vobiz account

Nothing until an agent acts:

| When | What it creates or changes |
|---|---|
| An agent signs in on the **Vobiz account** tab | Nothing. The Auth ID and Auth Token are checked with `GET /numbers?page=N&per_page=100`; a refusal is shown as "Vobiz rejected that Auth ID and Auth Token". Every page is read, and the account's `active`, voice-enabled numbers fill the caller ID dropdown. |
| The panel then asks for its phone line | One Application per account, named `VobizSF`, found by its answer URL (`<PUBLIC_BASE_URL>/answer`) or created. An application with any other answer URL is never touched. Then one SIP endpoint per agent, alias `vobiz-sf-<agentId>`, found from the endpoint map or by alias, or created. Every sign-in sets the endpoint a fresh random password, which only that agent's browser session receives. The endpoint is bound to the application with `{"app_id":"<id>"}`, read back with `GET /Endpoint/{id}/`, and if that did not take, bound again with the documented `{"application": <id>}`. |
| The agent clicks **Enable inbound calls** | One Application per account named `VobizSF_in`, answer URL `<PUBLIC_BASE_URL>/inbound-answer`, and the agent's selected number attached to it. **This moves that number off whichever application it was on** — the dropdown shows that application's id, and the result says it again. Nothing else ever attaches a number. |

**What is kept where.** Each account's Auth Token is held in memory only,
keyed by Auth ID, for as long as the process runs. It is never returned to a
browser, logged, or written to disk. The only file the backend writes is
`DATA_DIR/endpoints.json` (default `backend/data/`, mode 0600, git-ignored):
`{"<authId>:<agentId>": {"endpointId", "username"}}` — no password, no token.

**Routing.** An outbound call from the panel is identified by the SIP user on
the call, so it is placed on that agent's account, from the number they
selected (or the `X-VH-Caller-ID` the panel sent, if the account owns it). An
inbound call is matched to an account by the webhook's `ParentAuthID`, or by
the dialled number among signed-in accounts' numbers, and rings every open
panel of that account; the first to accept takes it. A number nobody signed in
for gets a short apology and a hangup, and a log line.

**After a restart** every agent signs in again. Until somebody from an account
has, that account's calls cannot be placed or routed — the panel asks for the
sign-in.

## Signing in with SIP direct

The **SIP direct** tab uses an endpoint the customer already has: the agent
types its SIP username and password, and the number to call from. The password
goes only to the Vobiz registrar; the backend is told the SIP username and the
caller ID, nothing else, and needs no account credentials at all.

Before an agent can use it, in the Vobiz Console:

1. **Voice → Applications → Create**: answer URL
   `https://<PUBLIC_BASE_URL host>/answer`, method `POST`, hangup URL the same.
2. **Voice → Endpoints**: open the endpoint and set its Application to that one.
3. **Phone Numbers**: open the number the agent types as caller ID and attach it
   to the same application (or to one whose answer URL is `/inbound-answer`).

The API equivalent, with your own Auth ID and Token:

```bash
# 1. the application — note the app_id it returns
curl -X POST https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Application/ \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_name":"VobizSF","answer_url":"https://<host>/answer","answer_method":"POST","hangup_url":"https://<host>/answer","hangup_method":"POST"}'
# 2. bind the endpoint (the app id as a string)
curl -X POST https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/ \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'
# 3. attach the number (E.164, + encoded as %2B)
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B<digits>/application" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

Then:

- **Outbound**: `/answer` sees the SIP user, and answers with
  `<Dial callerId="<typed number>"><Number>…</Number></Dial>`. No REST call is
  made. Vobiz itself refuses a caller ID the endpoint's account does not own.
- **Inbound**: a call to the typed number is answered with
  `<Dial callerId="<that number>" callerName="<caller's number>"><User>sip:<user>@registrar.vobiz.ai</User></Dial>`,
  and rings the panel directly. The caller's record pops and the call is
  logged as a Task; these calls are not recorded or sent to voicemail.
- **Not available**: the number list and **Enable inbound calls**, which need
  the account API. The panel says "Sign in with your Vobiz account to use
  this."

One SIP user per number: a second SIP user cannot claim a number another
signed-in SIP user is using. The backend cannot check a SIP password, so a
SIP-direct claim is only as strong as the panel's session cookie; Vobiz's own
registration is what proves the endpoint is theirs.

## Security

- **Sessions are an HttpOnly cookie**, `SameSite=None; Secure; Partitioned` so
  it survives inside Salesforce's frame. The panel never sees it and needs no
  code to send it. Every panel endpoint checks that the session belongs to the
  `agentId` it names.
- **No SIP password without that session.** `GET /agent/{agentId}` returns
  `{ "provisioned": false }` to anyone else.
- **Cross-site requests are refused.** Panel endpoints accept only
  `application/json` from this server's own origin, and nothing answers a CORS
  preflight, so another page cannot drive them with an agent's cookie.
- **Only the agent's own endpoint can spend their account.** `/answer` places a
  call over the REST API only when the SIP user on the call is the endpoint
  provisioned for a live session, and only with that session's account. A
  forged webhook cannot dial out. (A SIP-direct call is dialled by XML that
  Vobiz runs only for a call it is actually carrying.)
- **Webhook signatures** (`X-Vobiz-Signature-V3`, else `-V2`) are verified when
  present, with the token of the account the webhook belongs to (found from
  the SIP user, `ParentAuthID`, the dialled number or the room), and a bad one
  is refused. A SIP-direct webhook has no token to check against and is let
  through. Set `REQUIRE_VOBIZ_SIGNATURE=true` to refuse
  unsigned webhooks as well — check first that your account signs them.
- **The panel is served with `frame-ancestors`** limited to Salesforce, so no
  other site can frame it. Override with `SALESFORCE_FRAME_ANCESTORS`.
- **No recording proxy.** Recordings are played in the Vobiz Console.

## Running it in production

This is a reference, built to be read and adapted. Before real traffic:

- **State is in memory, in one process.** A restart signs every agent out and
  forgets any call in progress. Run one instance, or move the maps at the top
  of `server.js` into a shared store.
- **Use a stable hostname.** Every webhook URL is built from
  `PUBLIC_BASE_URL`, and Salesforce stores the adapter URL. A quick tunnel
  changes both on every restart.
- **One session per agent per account.** Signing in again with the same Auth
  ID and `agentId` replaces that agent's session; the same `agentId` on another
  account is a different agent.
- **Voicemail is recorded but not delivered.** Callers can leave a message;
  find it under Vobiz Console → Recordings.

## Tests

```bash
npm test
```

`tests/backend.test.mjs` covers every route — sign-in, provisioning, both call
directions, and requests the backend must refuse. It needs no Vobiz account or
network access.
