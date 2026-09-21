# Vobiz Calling for Salesforce

A softphone that puts [Vobiz](https://www.vobiz.ai) telephony inside Salesforce
Lightning. Agents place and receive real phone calls from the browser, phone
numbers across the CRM become click-to-dial, the matching record pops on every
call, and each finished call is logged as a Task — without leaving Salesforce.

Built on **Open CTI**, so there is nothing to package and no review to wait for.
You host a page; Salesforce frames it.

---

## Contents

- [What it does](#what-it-does)
- [Before you start](#before-you-start)
- [How it works](#how-it-works)
  - [Why there is a backend](#why-there-is-a-backend)
  - [Signing in: two ways](#signing-in-two-ways)
  - [An outbound call, step by step](#an-outbound-call-step-by-step)
  - [An inbound call, step by step](#an-inbound-call-step-by-step)
  - [Why both directions use a conference](#why-both-directions-use-a-conference)
  - [What Salesforce gets back](#what-salesforce-gets-back)
- [Setting it up](#setting-it-up)
- [Configuration](#configuration)
- [Using it day to day](#using-it-day-to-day)
- [Running it locally](#running-it-locally)
- [Repository layout](#repository-layout)
- [Limitations](#limitations)
- [Security](#security)
- [Support and licence](#support-and-licence)

---

## What it does

| | |
|---|---|
| **Outbound calling** | Dial from the panel, with two-way audio in the browser |
| **Click-to-dial** | Every phone number across Salesforce becomes clickable |
| **Inbound calling** | Calls to your Vobiz number ring the panel, with accept and decline |
| **Screen-pop** | The matching record opens while the call is still connecting |
| **Call logging** | Each finished call is written as a completed Task |
| **Recording** | Tick a box before dialling; play back in the Vobiz Console |
| **Two ways to sign in** | Account credentials, or a single SIP endpoint |

Two design decisions are worth knowing about, though an agent never sees either.

**Both directions use a conference room** rather than a direct bridge, which is
what keeps audio reliable in a browser. See [Why both directions use a
conference](#why-both-directions-use-a-conference).

**The browser always places the call, never receives one.** Even on an incoming
call, the panel dials out to join the caller.

---

## Before you start

### 1. Salesforce

- **Lightning Experience**, with **admin access**. Developer Edition is fine for
  evaluation.
- Your **My Domain host** — the `https://<something>.my.salesforce.com` address,
  found at Setup → **My Domain**. You will need it; it is not the
  `lightning.force.com` address you browse.

### 2. Vobiz

From the [Vobiz Console](https://console.vobiz.ai):

- An **Auth ID** and **Auth Token**.
- At least one **phone number** on the account. Carriers reject a call that
  presents no caller ID.
- For **SIP direct**, a **SIP endpoint** with a username and password (Console →
  Voice → Endpoints). Save the password when you create it — Vobiz does not show
  it again.

### 3. A calling backend

**This app holds no Vobiz credentials and cannot place a call by itself.** It
talks to a small service you run, which holds your Vobiz Auth Token and drives
the Vobiz REST API.

That service is **not in this repository**. Its complete contract — every
endpoint, the request and response shapes, and the security requirements — is in
**[docs/backend-contract.md](docs/backend-contract.md)**. Read it before you
start: the obvious implementation of the recording endpoint is unsafe, and the
document explains why.

The backend must be reachable:

- **from the public internet over HTTPS**, because Vobiz calls its webhooks; and
- **from the agent's browser**, with CORS configured for the panel's origin.

### 4. Somewhere to host the panel

Four static files and a vendored library. Any HTTPS host will do, but **serving
them from the calling backend is strongly recommended** — see
[Host the panel](#3-host-the-panel).

---

## How it works

### Why there is a backend

Vobiz's REST API is authenticated with your account **Auth Token**. Putting that
in a browser would hand every agent full control of the account — numbers,
billing, other people's calls.

So the browser never sees it. The panel talks only to your backend, and the
backend does three things:

1. Holds the Vobiz credentials and calls the Vobiz REST API.
2. Answers Vobiz's **answer webhook** — Vobiz asks "a call just arrived, what
   should I do with it?" and the backend replies with VobizXML.
3. Keeps a little per-agent state: who is signed in, which number they call
   from, and which caller is currently ringing them.

```
   ┌──────────────┐      HTTPS       ┌─────────────────┐     REST API    ┌────────┐
   │  the panel   │ ───────────────▶ │  your backend   │ ──────────────▶ │ Vobiz  │
   │ (in browser) │ ◀─────────────── │  (your server)  │ ◀────────────── │        │
   └──────┬───────┘                  └─────────────────┘  answer webhook └───┬────┘
          │                                                                  │
          └────────────── SIP over WebSocket + audio ────────────────────────┘
```

Audio never touches your backend. It runs directly between the browser and Vobiz.

### Signing in: two ways

The panel offers two tabs. **They differ only in how the agent is identified.
Once signed in, calling is identical** — same flow, same conference bridge, same
everything.

| | **Vobiz account** tab | **SIP direct** tab |
|---|---|---|
| Agent enters | **Auth ID** and **Auth Token** | The endpoint's **SIP username** and **password** |
| What it proves | Which Vobiz *account* pays for the call | Which *phone line* the browser is |
| Where the SIP identity comes from | The backend provisions or looks one up | The agent supplies it directly |
| Caller ID | Chosen from a dropdown of the account's numbers | Typed into **Calling from** |
| Backend involvement at sign-in | Validates, returns the SIP identity | **None** — the browser registers directly |
| What the browser holds | Account-wide credentials | One endpoint only |

#### Vobiz account flow

```
 agent types Auth ID + Auth Token
            │
            ▼
   POST /login  ──▶  backend validates against Vobiz
            │        and lists the account's numbers
            ▼
   backend provisions (or reuses) a SIP endpoint for this agent
            │
            ▼
   GET /agent/{agentId}  ──▶  returns SIP username + password
            │
            ▼
   panel registers with the Vobiz registrar over WebSocket  ──▶  Ready
```

The agent then picks which of the account's numbers outgoing calls present.

#### SIP direct flow

```
 agent types SIP username + password + the number to call from
            │
            ▼
   panel registers with the Vobiz registrar over WebSocket  ──▶  Ready
```

That is the whole flow. The backend is not contacted at all.

Because there is no account session behind it, the caller ID cannot be looked
up — listing an account's numbers is precisely what endpoint credentials do not
authorise. So the agent types it, and the panel attaches it to each call as a
SIP header the backend reads at answer time. The panel **refuses to connect
without one**: carriers reject a call with no caller ID, and that failure says
nothing about the cause.

#### What SIP direct cannot do

Two features need account credentials, so they are unavailable on that tab:

- **Enable inbound calls** — changing number routing is account-level. Inbound
  still *works* on a number already routed; you just cannot set it up here.
- **Listing recordings** — calls still record; the list is account-scoped.

Everything else — dialling, ringing, accepting, hanging up, screen-pop, the call
Task — is identical.

### An outbound call, step by step

```
 1. agent clicks Call, or clicks a phone number in Salesforce
            │
            ▼
 2. browser sends a SIP INVITE to sip:<destination>@<registrar>
            │                                    │
            │                                    ▼
 3.         │                        Vobiz asks the backend's answer URL
            │                                    │
            │                                    ▼
 4.         │                        backend replies "join conference room R"
            │                        and, over the REST API, dials the
            │                        destination into that same room R
            ▼                                    │
 5. agent waits in room R  ◀────────────────────┘
            │
            ▼
 6. destination answers, enters room R, audio flows both ways
```

The destination's phone rings **once**. Step 2 never reaches the phone network —
it terminates inside your Vobiz application, which is why the backend's answer
URL is called at all.

**Two CDRs are produced per call**, one per leg. That is normal: they are the
two halves of one conversation, with matching durations.

### An inbound call, step by step

```
 1. someone calls your Vobiz number
            │
            ▼
 2. Vobiz asks the backend's inbound answer URL
            │
            ▼
 3. backend parks the caller in conference room R with hold audio,
    and notes that agent A has a call ringing
            │
            ▼
 4. panel polls GET /inbound-pending/{agentId} once a second, sees the
    offer, rings, and shows the caller's number
            │
            ▼
 5. agent clicks Accept  ──▶  POST /inbound-accept
            │
            ▼
 6. browser places an ordinary OUTGOING call to the caller's number
            │
            ▼
 7. backend recognises it as the expected join and replies
    "join conference room R" instead of dialling anyone
            │
            ▼
 8. both legs are in room R, audio flows both ways
```

Step 6 looks wrong and is not: the browser has to dial something Vobiz can
route, and a room name is not routable — Vobiz's routing service rejects a
non-numeric destination outright. So the browser dials the caller's number, and
the backend substitutes the conference join before that number is ever rung.
**The caller is never called back.**

If no panel is listening when a call arrives, the backend sends the caller
straight to voicemail rather than holding them for an agent who is not there.

**Hanging up:** ending the call in the panel ends the agent's leg only — the
caller holds the room on their own and would otherwise stay connected in
silence. The panel therefore tells the backend, which releases the caller's leg
(`POST /inbound-hangup`). This works in reverse too: if the caller hangs up
first, their leg is already gone and the call is simply closed out.

### Why both directions use a conference

Both directions put the agent and the other party into a **conference room**
rather than bridging the two legs directly.

**Inbound** has to. A call cannot be delivered into a browser's registered SIP
endpoint, so there is no way to simply ring the panel. A conference is how both
parties end up in the same audio path — the caller waits in the room, and the
panel joins it.

**Outbound** does the same because it is the more reliable path for browser
audio: the agent waits in the room and the destination is dialled into it, each
leg established the way that leg works best. A direct bridge between a browser
leg and a phone leg is more fragile in practice, and a call that connects
without audio is worse than one that fails outright.

The cost is **two CDRs per call**, one per leg, with matching durations. They
are the two halves of one conversation — worth knowing when you read call
records or reconcile billing.

### What Salesforce gets back

**Click-to-dial.** Phone numbers across Salesforce become clickable — the app
turns this on; nothing in Salesforce does it by itself. Clicking one opens the
panel and dials.

**Screen-pop.** On both directions the panel looks the number up and opens the
matching record, so the agent lands on the right page while the call is still
connecting. One match pops automatically; several leave the agent to choose.

**A call Task.** When a call ends, the panel writes a completed **Task** —
direction, talk time, and a description, related to the matched record. A Task
is what Salesforce's own call logging produces, so these appear in Activity
History next to every other logged call.

**Talk time, not ring time.** A call that rang for 30 seconds and talked for 10
is logged as 10 seconds. An unanswered call is logged as zero.

**A CRM failure never breaks a call.** The call already happened; if the lookup
or the write fails it is logged to the console and the panel returns to Ready,
rather than showing a telephony error for a CRM problem.

---

## Setting it up

Full walkthrough with exact menu paths: **[docs/install.md](docs/install.md)**.
In outline:

### 1. Stand up a calling backend

Implement [docs/backend-contract.md](docs/backend-contract.md), reachable over
HTTPS from both Vobiz and the browser.

### 2. Trust the host in Salesforce

Setup → **Trusted URLs** → New, with **`frame-src`** ticked. Without this
Salesforce refuses to frame the panel and shows a blank box.

### 3. Host the panel

Copy `app/` to any HTTPS host. **Serving it from the calling backend is
strongly recommended**, for two reasons that have both caused real outages:

- Salesforce stores only a URL, so **every extra hostname is another thing that
  goes stale independently**. One origin, one thing to keep alive.
- Same origin means the panel's own calls to the backend are **not cross-origin
  at all**, so no CORS preflight is involved.

### 4. Create the Call Center

Setup → **Call Centers** → **Import**
[`call-center/call-center-definition.xml`](call-center/call-center-definition.xml),
then edit the record and set your own adapter URL with its
[parameters](#configuration).

### 5. Assign users, and add the utility item

**Manage Call Center Users** → add yourself. Then Setup → **App Manager** → edit
your Lightning app → **Utility Items** → **Open CTI Softphone**.

### 6. Hard-refresh and open it

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>, then click **Phone**. Salesforce
caches the adapter URL; a normal refresh keeps the old one.

---

## Configuration

Salesforce provides no settings UI, so every setting travels on the adapter
URL's query string:

```
https://calling.example.com/salesforce/softphone.html?org=https://your-org.my.salesforce.com&agentId=agent-one
```

| Parameter | Required | Default | What it is |
|---|---|---|---|
| `org` | **yes** | derived from the framing page | Your My Domain host. Open CTI is served per-org and there is no CDN copy, so the panel must be told where to load the toolkit from. |
| `agentId` | **yes** | — | Which identity this call centre registers as. **Every agent needs a different value**, or calls ring the wrong person. |
| `backendUrl` | no | wherever the panel was served from | Only needed when the panel is hosted away from the backend. |
| `registrarUrl` | no | `wss://registrar.vobiz.ai:5063/` | Leave alone unless Vobiz support says otherwise. |
| `apiVersion` | no | `64.0` | Open CTI API version. |

**For several agents, create one Call Center definition per agent**, each with a
different `agentId`, and assign the right users to each.

---

## Using it day to day

**Sign in** on either tab. Wait for the status badge to turn green before
dialling — the Call button stays disabled until the SIP endpoint registers,
deliberately, because dialling with SIP down rings the customer into silence.

**Make a call** by typing a number and clicking **Call**, or by clicking any
phone number in Salesforce.

The first call prompts for **microphone permission**. If it never prompts and
the call is silent, see the microphone note in
[docs/install.md](docs/install.md#microphone-access).

**Receive calls** by clicking **Enable inbound calls** once, on the Vobiz
account tab. After that:

- Keep the Salesforce tab **open**, and **only one tab**. Several tabs register
  the same SIP identity and evict each other, so a call can ring a tab that is
  no longer the one Vobiz will reach.
- When a call arrives the panel rings and shows the caller's number, with
  **Accept** and **Decline**. <kbd>Enter</kbd> and <kbd>Esc</kbd> do the same.
- **Accept** connects you. **Decline** sends the caller to voicemail.

**Record a call** by ticking **Record this call** before dialling. It applies to
inbound too — recording starts when you accept, so the caller's time on hold is
not in the file. Play recordings back in the **Vobiz Console → Voice →
Recordings**; the panel deliberately does not serve them, because doing so would
mean the calling backend could hand call recordings to anyone able to reach it.

### Call setup speed

The browser has work to do before it can send a call: it takes the microphone,
then gathers network candidates. Left alone that can take tens of seconds — and
on an inbound call the caller is on hold for all of it.

Two things keep it short. The offer is polled every second and the **microphone
is acquired while the banner is still ringing**, so accepting does not stop to
ask for one. And candidate gathering is **capped at 2.5 seconds** — the call is
sent as soon as one usable candidate exists.

That cap is a correctness fix as much as a speed one: candidates carry
short-lived network reservations, and an offer held back for tens of seconds can
describe a path that has already lapsed — which connects and bills a call with
no audio at all.

If setup is consistently slow, check for **many virtual network adapters** —
VPNs, Docker and similar each add interfaces the browser must enumerate.

---

## Running it locally

There is no build step and no framework. The panel is four files plus a vendored
library.

```bash
# anything that serves static files over HTTPS will do
npx serve app
```

Salesforce will not frame a plain-HTTP origin, so local work needs a tunnel or a
certificate. Whatever you use must **not** show a browser interstitial: a frame
cannot suppress one, and Salesforce shows a blank panel instead. ngrok's free
tier does show one; Cloudflare quick tunnels do not.

Then point a Call Center at the tunnel and hard-refresh Salesforce. Remember
that a quick tunnel gets a **new URL every restart** — a wildcard Trusted URL
(`https://*.trycloudflare.com`) saves re-doing step 2 each time.

**Editing:** change a file, hard-refresh Salesforce. There is nothing to
rebuild. Keep the browser console open — every failure mode names itself there,
and the message is more specific than anything Salesforce shows on screen.

---

## Repository layout

| Path | What it is |
|---|---|
| `app/softphone.html` | The panel's markup |
| `app/softphone.js` | The panel: sign-in, dialpad, call handling, CRM lookups |
| `app/opencti-host.js` | The Salesforce integration layer, backed by the Open CTI toolkit |
| `app/style.css` | Styles |
| `app/lib/jssip.min.js` | Vendored JsSIP browser bundle |
| `call-center/` | The Call Center definition to import |
| `docs/backend-contract.md` | **Every endpoint your backend must implement**, and its security requirements |
| `docs/install.md` | The Salesforce-side walkthrough, with troubleshooting |
| `docs/architecture.md` | Open CTI, the host adapter, and both call flows in detail |
| `tools/check-docs.mjs` | The documentation link checker CI runs |

---

## Limitations

Worth knowing before you roll it out.

- **Two CDRs per call**, one per leg — a consequence of the conference bridge,
  and the thing to know when reconciling call records.
- **A second caller while one is already ringing goes to voicemail.** One offer
  per agent at a time; there is no queue.
- **One agent per Call Center definition.** More agents need more definitions.
- **Browser calling only.** No option to route calls to a mobile or desk phone.
- **No hold, mute, transfer or conference** between agents.
- **Calls are logged as Tasks**, not Salesforce Voice Call records — those
  require Service Cloud Voice.
- **Recordings are not listed in the panel** — play them back in the Vobiz
  Console. This is deliberate: a panel that served recordings would mean the
  calling backend could hand call audio to anyone able to reach it.
- **No omnichannel presence.** The panel does not set agent availability.
- **Only one Salesforce tab** may be open with the panel signed in.

---

## Security

The panel stores no credentials of its own beyond what an agent explicitly asks
it to remember, and that stays in their browser on their machine.

Your Vobiz Auth Token belongs to your **backend**, never to the browser. The
security of this integration is therefore almost entirely the security of your
backend:
[docs/backend-contract.md](docs/backend-contract.md#security-requirements) has
the checklist, including the endpoints that are easy to implement in a way that
leaks call recordings. Please read it.

The **SIP direct** tab exists partly for this reason: an agent who only ever
works one endpoint can sign in without account-wide credentials ever reaching a
browser, and the backend never serves a SIP password.

Two Salesforce-specific notes:

- **Scope your Trusted URL** to the exact origin serving the panel. A wildcard is
  convenient during development and broader than you want in production.
- **The adapter URL is visible to any admin** and travels in the frame's address.
  Keep secrets out of it — the parameters this app accepts are all non-sensitive
  by design.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Support and licence

Built and maintained by **Vobiz**.

Licensed under the [MIT Licence](LICENSE), © 2026 Vobiz. This is an official
Vobiz integration, not a Salesforce product; Salesforce, Lightning, Open CTI and
Service Cloud are trademarks of Salesforce, Inc., used here only to describe
compatibility.

For anything about the Vobiz platform itself — accounts, numbers, billing —
email [support@vobiz.ai](mailto:support@vobiz.ai) or read the
[Vobiz documentation](https://www.vobiz.ai/docs).
