# How it works

## The shape of a Salesforce CTI app

Salesforce does not host softphones. It stores **a URL** and frames it.

That is the whole integration model, and it has consequences worth
understanding before anything else:

- **There is no packaging step.** No zip, no upload, no review. You host an HTML
  page; Salesforce embeds it.
- **You own the hosting.** If that URL stops resolving, the panel is a blank box
  and Salesforce reports nothing useful.
- **There is no settings UI.** Salesforce stores the URL and nothing else, so
  configuration travels on the URL's query string.
- **The org must trust the host.** Salesforce's Content Security Policy blocks
  framing anything not on its Trusted URLs list.

Inside the frame, Salesforce exposes a JavaScript API — **Open CTI** — for the
things a softphone needs from a CRM: make phone numbers clickable, receive those
clicks, pop a record, write an activity.

## What this app uses

| Open CTI call | Why |
|---|---|
| `enableClickToDial` | Phone numbers in Salesforce are not clickable until a softphone asks. Nothing else turns this on. |
| `onClickToDial` | Receives the click. Registered **inside** the enable callback — registering earlier silently receives nothing. |
| `searchAndScreenPop` | Finds the record for a number and opens it, in one call. Used on both directions. |
| `screenPop` | Opens a specific record by id. |
| `saveLog` | Writes the finished call as a completed **Task**, which is where Salesforce's own call logging puts it. |
| `setSoftphonePanelVisibility` | Opens the panel when a call starts, so click-to-dial does not dial invisibly. |

Every one of these takes a `callback` and returns nothing, so
`app/opencti-host.js` wraps each in a promise.

## The host adapter

`app/softphone.js` is the Freshsales panel, ported across almost unchanged. It
expects a Freshworks-shaped `client` object; `app/opencti-host.js` supplies that
shape backed by Open CTI.

```
  ┌─────────────────────────────────────────┐
  │ softphone.js — the panel                │
  │ (telephony, identical across platforms) │
  └───────────────┬─────────────────────────┘
                  │  client.events.on / client.interface.trigger
  ┌───────────────▼─────────────────────────┐
  │ opencti-host.js — the adapter           │
  │ (the only Salesforce-specific layer)    │
  └───────────────┬─────────────────────────┘
                  │  sforce.opencti.*
  ┌───────────────▼─────────────────────────┐
  │ Salesforce Lightning                    │
  └─────────────────────────────────────────┘
```

This exists so the two integrations do not drift. The conference bridge, the ICE
gathering cap, the placeholder-password gate and the caller release on hangup
are telephony, not CRM — none of it should be written twice. A fix made in the
Freshsales panel reaches this one by re-running
[`tools/port-from-freshsales.mjs`](../tools/port-from-freshsales.mjs).

## An outbound call, end to end

1. The agent clicks **Call**, or clicks a phone number anywhere in Salesforce.
2. **The browser sends the SIP INVITE itself**, to
   `sip:<destination>@<registrar>`. It is the A leg.
3. Vobiz routes that leg into the agent's application and fetches the backend's
   `/answer` webhook.
4. The backend replies with a `<Conference>` the agent waits in, and separately
   dials the destination into that same room over the Vobiz REST API.
5. The destination answers, enters the room, and audio flows.

Two things about this are deliberate.

**The browser is the A leg, not the B leg.** The Vobiz REST API cannot originate
a call to a registered WebRTC endpoint — it answers `Endpoint Not Registered`
and never dials anyone.

**The bridge is a conference, not `<Dial><Number>`.** `<Dial>` is the documented
way, and it loses the media intermittently: in measurement, three of five
browser-bridged outbound calls carried 98–99% packet loss on the phone leg while
the browser's own leg stayed clean, and control calls placed by the REST API
with no browser involved were clean every time. Signalling completes either way,
so a failed call still rings, answers and bills with nobody able to hear
anything.

## An inbound call

Vobiz cannot deliver a call *into* a registered WebRTC endpoint, so the panel is
never rung. The flow is inverted instead:

1. A call reaches your Vobiz number and hits the backend's `/inbound-answer`.
2. The backend parks the caller in a conference room playing hold audio, with
   voicemail as the next element in the same document.
3. The panel polls `/inbound-pending` once a second, sees the offer, rings, and
   shows the caller's number.
4. On **Accept**, the browser places an ordinary **outgoing** call to the
   caller's number — the direction that works.
5. The backend recognises that leg as the expected join and answers it with a
   `<Conference>` join instead of a dial, so the caller is never rung back.

Step 4 looks wrong and is not: the browser has to dial something Vobiz can
route, and a room name is not routable — Vobiz's routing service rejects a
non-numeric destination outright.

Ending the call needs one extra step. Terminating the browser's leg leaves the
caller holding the room alone, so the panel posts `/inbound-hangup` and the
backend releases the caller's leg. That is a hangup rather than ending the room:
a caller dropped out of `<Conference>` continues to the next element in the
document, which is the voicemail greeting.

## Binding inbound audio

Worth knowing if you modify the SIP code. For an **incoming** session, JsSIP has
not built the `RTCPeerConnection` yet — `session.connection` is `null` until the
call is answered. Dereferencing it inside the `newRTCSession` handler throws,
and because the throw happens inside that handler it aborts before `.answer()`
runs: the browser silently never picks up.

Bind through the `peerconnection` event instead, and only fall back to
`session.connection` when one already exists:

```js
session.on("peerconnection", e => bindTrack(e.peerconnection));
bindTrack(session.connection);   // no-op on the incoming path
```

## What is missing

- **No omnichannel presence.** The panel does not set agent availability.
- **No call control from Salesforce.** Hold, mute, transfer and conference are
  not implemented in either direction.
- **No Voice Call records.** Calls are logged as Tasks, not as Salesforce Voice
  objects, which require Service Cloud Voice.
- **One agent per Call Center definition.** A second agent needs a second
  definition with a different `agentId`.
