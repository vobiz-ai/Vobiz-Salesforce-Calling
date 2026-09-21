# Calling backend contract

This app is a client. It holds no Vobiz credentials and cannot place a call on
its own — it talks to a **calling backend** that you run, which holds the Vobiz
account credentials and drives the [Vobiz REST API](https://www.vobiz.ai/docs).

This document is the complete contract. Implement these endpoints and the app
works; nothing else is required of you.

> **The backend is not included in this repository.** It is a separate service.
> If you are building one, read the [security requirements](#security-requirements)
> first — the obvious implementation is unsafe.

## Why a backend exists at all

Two reasons, both non-negotiable:

1. **Vobiz Auth Tokens are account-level API credentials.** Vobiz's own
   documentation says never to expose `X-Auth-Token` in client-side code. The
   backend holds the token and the browser never sees it.
2. **A `<audio>` element cannot send authentication headers.** Call recordings
   are protected, so playback needs a server-side step. See
   [recordings](#get-recording-audioagentidrecordingid) for the right way to do
   this — a plain proxy is the wrong answer.

## Base URL

Everything below is relative to the `backend_url` installation parameter. The
app requires HTTPS and strips trailing slashes.

## Endpoints the browser calls

### `GET /agent/{agentId}`

Returns the SIP identity this panel registers as.

```json
{ "displayName": "Priya S", "sipUser": "priya@registrar.vobiz.ai", "sipPassword": "..." }
```

`sipUser` must be a full `user@domain` — the app builds `sip:${sipUser}`.

> **Do not serve a long-lived SIP password from an unauthenticated endpoint.**
> See [security requirements](#security-requirements).

### `GET /session/{agentId}`

Session restore, called when the panel loads.

```json
{ "loggedIn": true, "numbers": ["+919876543210"], "from": "+919876543210", "authId": "MA_XXXXXXXX" }
```

Return `{ "loggedIn": false }` when there is no session. Errors are swallowed by
the app.

### `POST /login`

```json
{ "agentId": "priya", "authId": "MA_XXXXXXXX", "authToken": "..." }
```

Validate against Vobiz, store the credentials server-side keyed by `agentId`,
and return the account's numbers:

```json
{ "numbers": ["+919876543210", "+919876543211"], "selected": "+919876543210" }
```

On failure return a non-2xx status with `{ "error": "..." }`.

### `POST /select-number`

```json
{ "agentId": "priya", "number": "+919876543211" }
```

→ `{ "selected": "+919876543211" }`

### `POST /start-call` — *no longer used for outbound*

The panel does **not** ask the backend to originate outbound calls any more. It
sends the SIP INVITE itself, so the browser is the **A leg**, and your `/answer`
handler decides what happens next — see [`/answer`](#getpost-answer).

The previous design — backend originates to the customer over the REST API, then
bridges the browser in with `<Dial><User>` — does not work: a call cannot be
delivered into a registered WebRTC endpoint. The browser places every call, and
your `/answer` handler decides what happens next.

Keep the route if you want a server-originated fallback (for ringing an agent's
mobile, say). Its shape is unchanged:

```json
{ "to": "+919876543210", "agentId": "priya", "platform": "freshsales" }
```

→ `{ "request_uuid": "..." }`

### `GET /call-status/{callUuid}?agentId={agentId}`

→ `{ "active": true }`

Polled every 3 seconds while a call is up.

### `POST /setup-inbound`

```json
{ "agentId": "priya" }
```

→ `{ "number": "+919876543210" }`

Creates (or reuses) a Vobiz application pointing at your `/inbound-answer`, and
attaches the agent's selected number to it.

Requires an account session. An agent signed in with endpoint credentials
(**SIP direct**) cannot call this — changing number routing is account-level —
so return an error rather than guessing at credentials.

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
  "from": "919876543210",
  "to": "+919876543211",
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

→ `{ "ok": true, "room": "zh...", "from": "919876543210", "callUuid": "..." }`

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

### `GET /recordings/{agentId}?limit=15`

```json
{ "objects": [ { "recording_id": "...", "add_time": "2026-09-14 10:30:00", "rounded_recording_duration": 42 } ] }
```

### `GET /recording-audio/{agentId}/{recordingId}`

Returns playable audio. The app assigns this URL directly to an `<audio>`
element, so **it cannot carry an `Authorization` header.**

**Do not solve this with an open proxy.** An endpoint that streams any
recording to anyone who knows the URL is a data breach waiting to happen, and
the listing endpoint above hands out the IDs. Instead:

- have `/recordings` return **signed, short-lived URLs** (a few minutes) that
  encode the recording ID and an expiry, and
- verify that signature on every request here.

## Endpoints Vobiz calls

These are webhooks. Vobiz must reach them over public HTTPS.

### `GET|POST /answer`

One handler serves both directions. Pick by looking at who the call is *from*:

- `From` starts with `sip:` (or `RouteType=sip`) → the **browser dialled out**.
- `From` is a plain number → a **PSTN caller** reached your DID.

When the browser is the A leg, check first whether a join is expected for this
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
              callbackUrl="https://you.example.com/conf-event?agentId=priya"
              callbackMethod="POST">ROOM</Conference>
  <Hangup/>
</Response>
```

```
POST /api/v1/Account/{auth_id}/Call/
  to=919876543211
  from=+919876543210
  answer_url=https://you.example.com/outbound-join?room=ROOM&agentId=priya
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

**Caller ID.** The A leg's own caller ID is a SIP username, which is not a
dialable CLI. Use, in order: the `X-VH-Caller-ID` header the panel sends (the
only source an agent signed in with endpoint credentials has), then the number
selected in their account session, then your account default.

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

The answer URL for calls to your DID. Park the caller in a room of their own and
follow it with voicemail:

```xml
<Response>
  <Conference stayAlone="true" startConferenceOnEnter="false"
              endConferenceOnExit="true"
              waitSound="https://you.example.com/conf-wait"
              timeLimit="3600"
              callbackUrl="https://you.example.com/conf-event?agentId=priya"
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
read SIP passwords, place calls billed to your account, rewrite your inbound
number routing, and download every call recording.

A backend implementing this contract must therefore:

- [ ] **Authenticate every request.** Do not treat `agentId` as proof of
      identity. Issue a per-agent token at login and require it.
- [ ] **Not serve long-lived SIP passwords.** Mint short-lived credentials, or
      gate `/agent/{agentId}` behind the same authentication.
- [ ] **Sign recording URLs** with a short expiry, as described above.
- [ ] **Scope CORS to the Salesforce origin.** Never `Access-Control-Allow-Origin: *`.
- [ ] **Store Auth Tokens encrypted at rest**, and never log them.
- [ ] **Serve over HTTPS** with a stable hostname.

If you are adapting a prototype, assume it does none of these.
