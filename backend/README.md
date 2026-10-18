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

## What it does with your Vobiz account

Nothing until an agent acts:

| When | What it creates or changes |
|---|---|
| An agent signs in on the **Vobiz account** tab | Nothing. The Auth ID and Auth Token are checked by listing the account's numbers. |
| The panel then asks for its phone line | An Application named `VobizSF_<agentId>` whose answer URL is this server's `/answer`, and a SIP endpoint with alias `vobiz-sf-<agentId>` attached to it. Signing in again reuses both and sets a new endpoint password. |
| The agent clicks **Enable inbound calls** | An Application named `VobizSF_in_<agentId>` pointing at `/inbound-answer`, and the agent's selected number attached to it. **This changes where that number's calls go.** |

Each agent's own Auth ID and Auth Token are used for everything done on their
behalf. They are held in memory for the session (12 hours by default) and are
never written to disk or logged.

## Signing in with SIP direct

The **SIP direct** tab registers an endpoint the agent already has, with no
account session. Two things follow:

- **Outbound** calls still reach this server's `/answer`, and placing the
  destination leg needs account credentials. Set `VOBIZ_AUTH_ID` and
  `VOBIZ_AUTH_TOKEN`, list the endpoint's username in `SIP_DIRECT_USERNAMES`,
  and in the Vobiz Console attach that endpoint to an Application whose answer
  URL is `https://<PUBLIC_BASE_URL host>/answer`.
- **Inbound** is not offered to SIP direct sign-ins: this backend only hands an
  incoming caller to a signed-in account session.

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
  call only when the SIP user on the call is the endpoint provisioned for that
  agent's live session (or a listed SIP direct username). A forged webhook
  cannot dial out.
- **Webhook signatures** (`X-Vobiz-Signature-V3`, else `-V2`) are verified when
  present and a bad one is refused. Set `REQUIRE_VOBIZ_SIGNATURE=true` to refuse
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
- **One agent per `agentId`.** Signing in again replaces that agent's session.
- **Voicemail is recorded but not delivered.** Callers can leave a message;
  find it under Vobiz Console → Recordings.

## Tests

```bash
npm test
```

`tests/backend.test.mjs` drives every route against a fake Vobiz API — sign-in,
provisioning, both call directions, and the requests an attacker would send. It
does not place real calls.
