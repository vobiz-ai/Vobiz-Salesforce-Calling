# Calling backend contract

This app is a client. It holds no Vobiz credentials and cannot place a call on
its own — it talks to a **calling backend** that you run, which holds the Vobiz
account credentials and drives the [Vobiz REST API](https://www.vobiz.ai/docs).

This document is the complete contract. Implement these endpoints and the app
works; nothing else is required of you.

> **A reference implementation is included:** [`backend/`](../backend/README.md).
> Run it as-is, or read it alongside this document. If you are building your
> own, read the [security requirements](#security-requirements) first — the
> obvious implementation is unsafe.

## Why a backend exists at all

Two reasons, both non-negotiable:

1. **Vobiz Auth Tokens are account-level API credentials.** Vobiz's own
   documentation says never to expose `X-Auth-Token` in client-side code. The
   backend holds the token and the browser never sees it.
2. **Vobiz needs someone to ask.** Every call the panel places, and every call
   to your number, fetches an answer URL for its VobizXML. That has to be a
   public HTTPS server.

## Base URL

Everything below is relative to the origin that served the panel, or to the
adapter URL's `?backendUrl=` when the panel is hosted elsewhere. The app
requires HTTPS (plain `http://localhost` is allowed for development) and strips
trailing slashes.

The panel sends no authentication header of its own. Its requests are ordinary
`fetch` calls with the browser's default credentials mode, so **a cookie your
backend sets at `/login` is sent back on every same-origin request** — which is
how the reference backend authenticates them. See
[security requirements](#security-requirements).

## Endpoints the browser calls

### `GET /agent/{agentId}`

Returns the SIP identity this panel registers as. Called on load, and again
right after `/login`.

```json
{ "displayName": "Priya S", "sipUser": "priya@registrar.vobiz.ai", "sipPassword": "...", "provisioned": true }
```

`sipUser` must be a full `user@domain` — the app builds `sip:${sipUser}`.

Before the agent has signed in, return `{ "provisioned": false }` with no
password. The panel then shows "Sign in below" instead of trying to register.

> **Do not serve a long-lived SIP password from an unauthenticated endpoint.**
> See [security requirements](#security-requirements).

### `GET /session/{agentId}`

Session restore, called when the panel loads.

```json
{ "loggedIn": true, "numbers": ["+910000000001"], "from": "+910000000001", "authId": "MA_XXXXXXXX" }
```

Return `{ "loggedIn": false }` when there is no session. Errors are swallowed by
the app.

### `POST /login`

```json
{ "agentId": "priya", "authId": "MA_XXXXXXXX", "authToken": "..." }
```

Any Vobiz account may sign in. Validate the pair against Vobiz with
`GET /api/v1/Account/{authId}/numbers?page=N&per_page=100` (a non-2xx is a
401 for the panel), reading every page and keeping numbers with
`status === "active"` and `voice_enabled !== false`. Keep the Auth Token
server-side, in memory, keyed by **Auth ID** — never return it, log it or write
it to disk — and key the agent's session by `(authId, agentId)`, since two
accounts can both have an agent called `agent-one`. Return the numbers and the
application each is on now:

```json
{ "numbers": ["+910000000001", "+910000000002"], "numberApps": { "+910000000001": "<app id or null>" }, "selected": "+910000000001" }
```

Do not check the Auth ID against an account the backend was configured for:
there is none.

On failure return a non-2xx status with `{ "error": "..." }`.

### `POST /select-number`

```json
{ "agentId": "priya", "number": "+910000000002" }
```

→ `{ "selected": "+910000000002" }`

Refuse a number that is not in the account's list.

### `POST /setup-inbound`

```json
{ "agentId": "priya", "platform": "salesforce" }
```

→ `{ "number": "+910000000001", "applicationId": "...", "previousApplicationId": "..." }`

Finds (by answer URL) or creates a Vobiz application pointing at your
`/inbound-answer` in the agent's account, and attaches the agent's selected
number to it — the only place a number is ever attached, because it moves the
number off whatever application it was on.

Requires an account session. An agent signed in with endpoint credentials
(**SIP direct**) cannot call this — changing number routing is account-level —
so return an error ("Sign in with your Vobiz account to use this.").

### `POST /sip-direct`

```json
{ "agentId": "priya", "sipUser": "deskphone01", "callerId": "+910000000004" }
```

→ `{ "sipUser": "deskphone01", "callerId": "+910000000004" }`, and a session cookie.

The SIP-direct sign-in. The panel registers with the SIP password itself and
never sends it here. Record `sipUser -> callerId` (strict E.164) so the
webhooks can route this endpoint's calls; no account credentials are involved.

### `GET /inbound-pending/{agentId}`

Polled **once a second** while the panel is registered and idle. This is how an
incoming call reaches the agent, and it doubles as the signal that a softphone
is connected at all.

Nothing ringing:

```json
{ "pending": false }
```

A caller waiting:

```json
{
  "pending": true,
  "room": "zh<call-uuid-without-punctuation>",
  "from": "910000000098",
  "to": "+910000000002",
  "callUuid": "..."
}
```

> **Treat a recent poll as proof that an agent is reachable.** When an inbound
> call arrives and nothing has polled for this agent recently, send the caller
> to voicemail immediately instead of holding them for an agent who is not
> there. A grace window of about five missed ticks works well.

### `POST /inbound-accept`

```json
{ "agentId": "priya" }
```

→ `{ "ok": true, "room": "zh...", "from": "910000000098", "callUuid": "..." }`

Stop the no-answer timer **here**, before the browser's leg arrives — a slow
join otherwise races the caller into voicemail. Record that a join is now
expected for this agent, because `/answer` needs to know (see below).

If nothing is ringing, return `{ "ok": false, "reason": "..." }`. The caller may
have hung up in the second it took to click.

### `POST /inbound-decline`

```json
{ "agentId": "priya" }
```

→ `{ "ok": true }`

End the conference room. The caller drops out of `<Conference>` and continues to
the voicemail that follows it in the document you already returned.

### `POST /inbound-hangup`

```json
{ "agentId": "priya", "callUuid": "..." }
```

→ `{ "ok": true }`

Sent when the agent's leg of an **answered** inbound call ends.

**Hang the caller's leg up — do not end the room.** Ending the room drops the
caller out of `<Conference>` and on into the voicemail that follows it, so a
finished conversation would be answered with "leave a message after the beep".
Hang the leg up instead:

```
DELETE /api/v1/Account/{auth_id}/Call/{call_uuid}/
```

This fires in both directions. If the caller hung up first their leg is already
gone and the delete returns `404` — treat that as success.

> The panel is usually the only side that still knows the caller's `callUuid` by
> this point, which is why it sends it. Prefer the value it sends over your own
> state.

## Endpoints Vobiz calls

These are webhooks. Vobiz must reach them over public HTTPS.

### `GET|POST /answer`

One handler serves both directions. Pick by looking at who the call is *from*:

- `From` starts with `sip:` (or `RouteType=sip`) → the **browser dialled out**.
- `From` is a plain number → a **PSTN caller** reached your DID.

**Check that the SIP user on the call is this agent's own endpoint** before
doing anything that costs money. `/answer` is a public URL; without this check,
anyone who can POST to it can have your backend dial any number on your bill.

When the browser is the A leg, check next whether a join is expected for this
agent (set by `/inbound-accept`). If one is, this leg is the agent coming to
meet a waiting caller — **not** a new outbound call:

```xml
<!-- the agent joining a caller who is already waiting -->
<Response>
  <Conference startConferenceOnEnter="true" stayAlone="false"
              endConferenceOnExit="false" timeLimit="3600">ROOM</Conference>
  <Hangup/>
</Response>
```

> **Check this before looking at what was dialled.** The browser dialled the
> *caller's* number to get here, because a room name is not a destination Vobiz
> can resolve — its routing service answers `500` for a non-numeric destination
> and the leg ends as a bogus `486 Busy`. The number on the wire is theirs, and
> this `<Conference>` replaces the dial, so they are never actually rung.
>
> Consume the expectation here, whichever way it goes. Leaving it behind makes
> the agent's next ordinary outbound call look like a join and be refused.

Otherwise this is a genuine outbound call. Put the agent in a room of their own
and dial the destination into it over the REST API:

```xml
<!-- outbound: the agent waits, the destination is dialled separately -->
<Response>
  <Conference stayAlone="true" startConferenceOnEnter="false"
              endConferenceOnExit="true"
              waitSound="https://you.example.com/outbound-wait"
              timeLimit="14400"
              callbackUrl="https://you.example.com/conf-event?room=ROOM&amp;role=agent"
              callbackMethod="POST">ROOM</Conference>
  <Hangup/>
</Response>
```

```
POST /api/v1/Account/{auth_id}/Call/
  to=910000000002
  from=+910000000001
  answer_url=https://you.example.com/outbound-join?room=ROOM
  answer_method=GET
```

> **Why not `<Dial><Number>`?** Bridging a browser leg directly to a phone leg
> is unreliable for media — the call rings, answers and bills, and one side
> hears nothing, because signalling succeeds whether or not audio does. A
> conference establishes each leg separately, which is the arrangement that
> carries audio consistently.
>
> If you implement the `<Dial>` path anyway, keep it behind a flag so you can
> switch back without a deploy.

**Who is calling** comes from the SIP user in `From`, mapped to the session
whose endpoint it is — never from a query parameter, which anyone can write.

**Caller ID.** The A leg's own caller ID is a SIP username, which is not a
dialable CLI. Use the `X-VH-Caller-ID` header the panel sends (it may arrive as
`SIPHeader_X-VH-Caller-ID`) when the account owns that number, otherwise the
number selected in the session. Never a number from configuration.

**SIP direct.** A SIP user signed in through `/sip-direct` has no account
credentials behind it, so there is no REST call to make: answer with
`<Dial callerId="<caller ID>"><Number>…</Number></Dial>` and let Vobiz refuse a
caller ID the account does not own.

**An `Event=Hangup` request is not a request for instructions.** Answer it with
an empty `<Response></Response>`; returning call-control XML originates a fresh
leg after the call has already ended.

### `GET /outbound-join`

The answer URL for the REST-placed destination leg above. Put them in the same
room, and let their arrival start it:

```xml
<Response>
  <Conference startConferenceOnEnter="true" stayAlone="false"
              endConferenceOnExit="true" timeLimit="14400">ROOM</Conference>
  <Hangup/>
</Response>
```

With `endConferenceOnExit` on both legs, either party hanging up tears the other
down without the backend having to intervene.

### `GET /outbound-wait`

What the agent hears while the destination's phone rings. Silence is fine; the
panel shows the state.

```xml
<Response><Wait length="3"/></Response>
```

### `GET|POST /conf-event`

The `callbackUrl` above. Vobiz posts `ConferenceAction` (`enter` / `exit`),
`ConferenceName` and `CallUUID`. Return an empty `<Response></Response>`.

Three things belong here:

- **The second `enter` on an outbound room is the destination answering.** That
  is what cancels your no-answer timer. Nothing in the `<Conference>` attributes
  expresses "give up if the second member never arrives", so bound it yourself —
  otherwise an unanswered call leaves the agent waiting until `timeLimit`.
- **The room emptying is the definitive end of an outbound call.** There is no
  `<Dial>` any more, so there is no `action` callback: whatever you used to do
  when a dial finished belongs here.
- **An `exit` on an inbound room** means the caller gave up. A browser leg still
  on its way should then be refused rather than dialling them back.

### `GET|POST /dial-status`

Only reached if you keep a `<Dial>` path. Return `200` with an empty body. Log
`DialStatus`, `DialHangupCause` and especially `DialBLegUUID` — an empty
`DialBLegUUID` means no B leg was ever created, which is the signature of an
unreachable destination or a caller ID the account does not own.

### `GET|POST /inbound-answer`

The answer URL for calls to your DID. First find whose call it is: the
webhook's `ParentAuthID` names the account; fall back to matching the dialled
`To` against signed-in accounts' numbers. Ring that account's open panels, and
no other account's. If nobody is signed in for it, a short `<Speak>` and
`<Hangup/>`, and a log line. If the number belongs to a SIP-direct sign-in,
answer `<Dial callerId="<To in E.164>"><User>sip:<user>@registrar.vobiz.ai</User></Dial>`.

Otherwise park the caller in a room of their own and follow it with voicemail:

```xml
<Response>
  <Conference stayAlone="true" startConferenceOnEnter="false"
              endConferenceOnExit="true"
              waitSound="https://you.example.com/conf-wait"
              timeLimit="3600"
              callbackUrl="https://you.example.com/conf-event?room=ROOM&amp;role=agent"
              callbackMethod="POST">ROOM</Conference>
  <!-- reached only if the room ends before an agent joins -->
  <Speak>Sorry, nobody is available. Please leave a message after the beep.</Speak>
  <Record .../>
</Response>
```

Each attribute earns its place:

| Attribute | Without it |
|---|---|
| `stayAlone="true"` | Vobiz disconnects the caller on entry, before the agent is even told |
| `startConferenceOnEnter="false"` | an open room with nobody in it, instead of hold audio |
| `endConferenceOnExit="true"` | the caller hangs up and the agent's leg is left in a dead room |

A no-answer timeout of around 20–45 seconds, enforced in your backend and
falling through to the voicemail above, is a sensible default. No `<Conference>`
attribute expresses it without also capping the conversation.

> **If recording, `<Record>` must be a sibling *before* `<Conference>`, never
> nested inside it.** Nested, FreeSWITCH rejects the whole document as Invalid
> Answer XML and then answers `486`, which reaches the caller as a bogus "Busy".

## Security requirements

The app sends `agentId` as a plain string in the path, body, or query. **If your
backend trusts that string, every endpoint above is unauthenticated and the
`agentId` is guessable.** An attacker who learns your backend URL could then
read SIP passwords, place calls billed to your account, and rewrite your
inbound number routing.

A backend implementing this contract must therefore:

- [ ] **Authenticate every request.** Do not treat `agentId` as proof of
      identity. Set a session at `/login` and require it, matched to the
      `agentId` in the request. The panel sends no header of its own, so use an
      `HttpOnly; Secure; SameSite=None; Partitioned` cookie — the panel runs in
      a frame inside Salesforce, where any other cookie is dropped as
      third-party — and serve the panel from the backend so the cookie is
      same-origin.
- [ ] **Not serve SIP passwords without that session.** `/agent/{agentId}`
      answers `{ "provisioned": false }` to anyone else.
- [ ] **Refuse cross-site requests.** Accept only `application/json` bodies
      (which forces a CORS preflight) and answer no preflight from other
      origins. Never `Access-Control-Allow-Origin: *`. If the panel is hosted
      on a different origin, allow exactly that origin — it is the panel's
      origin that makes the requests, not Salesforce's.
- [ ] **Dial only for the agent's own endpoint** on `/answer`, as above, and
      verify `X-Vobiz-Signature-V3` on webhooks when Vobiz sends it.
- [ ] **Not proxy call recordings.** An endpoint that streams any recording to
      anyone who knows its id is a data breach. Play them in the Vobiz Console,
      or sign short-lived URLs.
- [ ] **Store Auth Tokens encrypted at rest**, if you store them at all, and
      never log them.
- [ ] **Serve over HTTPS** with a stable hostname, and send
      `Content-Security-Policy: frame-ancestors` limited to Salesforce on the
      panel's pages.

If you are adapting a prototype, assume it does none of these.
