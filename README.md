# Vobiz Calling for Salesforce

Vobiz Calling for Salesforce puts a [Vobiz](https://www.vobiz.ai) softphone
inside Salesforce Lightning. Your agents make and take real phone calls in the
browser, from a panel in the Salesforce utility bar. Phone numbers across
Salesforce become click-to-dial, the matching record opens when a call starts,
and every finished call is logged as a completed Task. The integration is built
on Salesforce **Open CTI**, so there is no package to install: you run a small
calling backend (included in this repository), and Salesforce frames the panel
it serves.

**Features**

- **Click-to-call.** Click any phone number in Salesforce, or type one into the
  panel, and the call goes out with two-way audio in the browser.
- **Inbound calls with screen pop.** Calls to your Vobiz number ring the panel
  with **Accept** and **Decline**, and the caller's record opens while it rings.
- **Call logging.** Each finished call is written to Salesforce as a completed
  Task, related to the matching Contact, Lead or other record.
- **Recording.** Tick **Record this call** before dialling. Recordings are kept
  in your Vobiz account and played back in the Vobiz Console.
- **Caller ID choice.** Pick which of your Vobiz numbers outgoing calls show.
- **Multi-agent.** Each agent gets their own phone line; an inbound call rings
  every agent of that Vobiz account whose panel is open, and the first to
  accept takes it.
- **Two ways to sign in.** With your Vobiz account (Auth ID and Auth Token), or
  directly with an existing SIP endpoint.
- **Voicemail.** A caller nobody answers can leave a message.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Sign in](#sign-in)
- [Using it](#using-it)
- [Configuration reference](#configuration-reference)
- [Deploying to production](#deploying-to-production)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development)
- [Support and links](#support-and-links)

---

## How it works

```
   Salesforce (Lightning)                 your backend                   Vobiz
 ┌────────────────────────┐   HTTPS   ┌──────────────────┐  REST API  ┌──────────┐
 │  Open CTI panel        │ ────────▶ │ backend/server.js│ ─────────▶ │ API      │
 │  (utility bar)         │ ◀──────── │                  │ ◀───────── │ webhooks │
 └───────────┬────────────┘           └──────────────────┘            └────┬─────┘
             │                                                             │
             └──────────── SIP over secure WebSocket + call audio ─────────┘
```

- **Salesforce frames a page you host.** A Call Center record holds the panel's
  URL; the panel loads Salesforce's Open CTI toolkit to make numbers clickable,
  open records and write Tasks.
- **Your backend serves the panel and holds the Vobiz session.** The panel
  never calls the Vobiz API itself. It talks only to your backend, which calls
  the Vobiz REST API and answers Vobiz's webhooks.
- **Audio goes straight between the browser and Vobiz.** The panel registers as
  a Vobiz SIP endpoint over a secure WebSocket (`wss://registrar.vobiz.ai`).
  Call audio never passes through your backend.
- **Outbound:** the browser places the call, Vobiz asks your backend what to do
  (`/answer`), and the backend puts the agent in a conference room and dials
  the destination into it.
- **Inbound:** Vobiz asks your backend (`/inbound-answer`), the backend holds
  the caller in a conference room with hold audio, and the panel rings. When
  the agent accepts, the panel joins that room.
- **Salesforce gets the result:** the record pops when the call starts, and a
  Task is written when it ends.

Because each call is a conference with two legs, **each call produces two Vobiz
call records (CDRs)**, one per leg, with matching durations.

---

## Requirements

**Vobiz**

- A Vobiz account. Your **Auth ID** and **Auth Token** are on the
  [Vobiz Console](https://console.vobiz.ai) dashboard, under **API
  credentials**. The Auth Token is not your login password.
- At least one **phone number** on the account. Carriers reject a call that
  presents no caller ID.
- Account **balance** for calls and recordings.

**Salesforce**

- **Lightning Experience**, in an edition that includes Call Centers and Open
  CTI (Professional, Enterprise, Performance, Unlimited or Developer Edition).
- A **System Administrator** (or a user who can manage Call Centers, Trusted
  URLs, Session Settings and the App Manager).
- Your **My Domain** URL — the `https://<your-org>.my.salesforce.com` address
  at Setup → **My Domain**. It is not the `lightning.force.com` address you
  browse.

**Your backend**

- A server with **Node.js 20.12 or later**. The backend has no dependencies, so
  there is no `npm install`.
- A **public HTTPS URL** for it, such as `https://calling.example.com`, with a
  valid certificate. Vobiz calls its webhooks there and Salesforce frames the
  panel from there. Salesforce will not frame a plain-HTTP page.

**Agents**

- A current desktop **Chrome, Edge or Firefox**, with a **microphone** and
  speakers or a headset.

---

## Quick start

1. **Get the code.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-Salesforce-Calling.git
   cd Vobiz-Salesforce-Calling
   ```

2. **Configure the backend.** Only deployment settings go here — no Vobiz
   credentials. Agents sign in from the panel.

   ```bash
   cp backend/.env.example backend/.env
   ```

   Set `PUBLIC_BASE_URL` to the public HTTPS address of this server, with no
   trailing slash:

   ```bash
   PUBLIC_BASE_URL=https://calling.example.com
   PORT=8080
   ```

   Every setting is listed in the [Configuration reference](#configuration-reference).

3. **Start it.**

   ```bash
   npm start          # same as: node backend/server.js
   ```

   It prints the panel URL and the webhook URLs it will hand to Vobiz.

4. **Expose it publicly.** Put the server behind HTTPS at `PUBLIC_BASE_URL` —
   a reverse proxy with a certificate, or your hosting platform's HTTPS. Check
   it from outside your network:

   ```bash
   curl https://calling.example.com/healthz      # {"ok":true}
   ```

   For a quick trial on your own machine, a Cloudflare quick tunnel works:
   `cloudflared tunnel --url http://localhost:8080`. Use a tunnel that does not
   show a browser warning page; Salesforce cannot display one inside its frame.

5. **Trust the backend in Salesforce.** Setup → **Trusted URLs** → **New
   Trusted URL**. Set the URL to your backend's origin
   (`https://calling.example.com`), CSP Context **All**, and tick the
   **`frame-src`** and **`connect-src`** directives. Under **Permissions Policy
   Directives**, tick **microphone**. Save.

   If **microphone** is greyed out, go to Setup → **Session Settings** →
   **Browser Feature Permissions**, set **Microphone** to **Trusted URLs
   Only**, save, and come back.

6. **Create the Call Center.** Setup → **Call Centers** → **Import**, and
   choose [`call-center/call-center-definition.xml`](call-center/call-center-definition.xml)
   from this repository. Open the imported **Vobiz Calling** record, click
   **Edit**, and set **CTI Adapter URL** to:

   ```
   https://calling.example.com/salesforce/softphone.html?org=https://your-org.my.salesforce.com&agentId=agent-one
   ```

   Use your own backend host, your own My Domain URL, and an `agentId` for this
   agent (letters, digits, `-` or `_`, up to 40 characters). Save.

7. **Assign users.** On the Call Center record, click **Manage Call Center
   Users** → **Add More Users**, select the agent, and click **Add to Call
   Center**. Each agent needs their own Call Center with their own `agentId` —
   see [Several agents](#several-agents).

8. **Add the phone to your app.** Setup → **App Manager** → your Lightning app
   (for example **Service Console**) → **Edit** → **Utility Items (Desktop
   Only)** → **Add Utility Item** → **Open CTI Softphone**. Set the height to at
   least 600 and the width to 400. Save.

9. **Open it.** Open that app and **hard-refresh** the page
   (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>, or
   <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on a Mac). Salesforce caches the
   adapter URL, and a normal refresh keeps the old one. Click **Phone** in the
   utility bar, then [sign in](#sign-in).

A step-by-step walkthrough of the Salesforce side, with more troubleshooting, is
in [docs/install.md](docs/install.md).

---

## Sign in

The panel has two tabs: **Vobiz account** and **SIP direct**. Any Vobiz account
works with either, and agents on different Vobiz accounts can use the same
backend at the same time.

### Vobiz account (recommended)

Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token**, then click **Log in**.

The backend checks the pair with Vobiz and lists the account's numbers. Then,
in **your** Vobiz account, it sets up:

| What | Details |
|---|---|
| One application, **`VobizSF`** | Answer URL `<PUBLIC_BASE_URL>/answer` (method `POST`). Found by that answer URL if it already exists, otherwise created. An application with any other answer URL is never changed. |
| One SIP endpoint per agent | Alias `vobiz-sf-<agentId>`, attached to `VobizSF`. Reused on later sign-ins. Each sign-in gives it a new random password, which only that agent's browser receives. |

The panel then registers with that endpoint, and the status badge turns green
(**Ready**).

**Choose a caller ID.** **Calling from** lists every active, voice-enabled
number on the account, with the application each is on now. Your first number
is selected; pick another at any time. The backend refuses a number that is not
on the account.

**Enable inbound calls.** To have calls to your number ring the panel, click
**Enable inbound calls** once, under **Receive calls here**. This:

- finds or creates a second application, **`VobizSF_in`**, with answer URL
  `<PUBLIC_BASE_URL>/inbound-answer`, and
- attaches the number selected in **Calling from** to it.

**This moves that number off the application it is on now**, so any other
setup that number was routed to stops receiving its calls. The dropdown shows
the number's current application, and when you click the button the panel
confirms the change and names the application the number was moved off. This
button is the only thing in the integration that changes where a number's calls
go. To move the number back, attach it to its previous application in the Vobiz
Console.

### SIP direct

Use this tab to sign in as an endpoint you already have, without giving the
backend your Auth Token. Enter:

- **SIP username** and **SIP password** of the endpoint (Vobiz Console →
  Voice → Endpoints). Vobiz shows an endpoint's password only when you set it;
  if you do not have it, set a new one on the endpoint.
- **Calling from** — the number outgoing calls show, in E.164 format
  (`+91XXXXXXXXXX`). It must be a number on the endpoint's account. The panel
  will not connect without one.

Tick **Remember these** to keep them in this browser (see
[Security and privacy](#security-and-privacy)), then click **Connect**.

**Before an agent uses SIP direct**, point the endpoint and the number at your
backend. In the [Vobiz Console](https://console.vobiz.ai):

1. **Voice → Applications → Create.** Answer URL
   `https://calling.example.com/answer`, method `POST`. Set the hangup URL to the
   same address.
2. **Voice → Endpoints.** Open the endpoint and set its **Application** to the
   one you just created.
3. **Phone Numbers.** Open the number the agent will type as **Calling from**
   and attach it to the same application.

The same steps with the Vobiz API:

```bash
# 1. Create the application and note the app_id it returns
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Application/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_name":"VobizSF","answer_url":"https://calling.example.com/answer","answer_method":"POST","hangup_url":"https://calling.example.com/answer","hangup_method":"POST"}'

# 2. Attach the endpoint to it (the app_id as a string)
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'

# 3. Attach the number (E.164, with + written as %2B)
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/numbers/%2B91XXXXXXXXXX/application" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

**What works differently with SIP direct:**

- **Outbound** calls work as with an account sign-in: click-to-dial, screen
  pop, recording and the call Task.
- **Inbound** calls to the **Calling from** number ring the panel directly,
  with **Accept** and **Decline**. The caller's record opens while it rings,
  and the call is logged as a Task — answered, missed or declined. These calls
  cannot be recorded and do not go to voicemail: a call nobody accepts simply
  ends.
- **Not available:** the **Calling from** dropdown and **Enable inbound
  calls**, which need your Auth Token. The panel says "Sign in with your Vobiz
  account to use this."
- One number per SIP sign-in: a second SIP direct agent cannot use a number
  another signed-in SIP direct agent is already using.

### Several agents

Salesforce stores one adapter URL per Call Center, so **create one Call Center
per agent**, each with a different `agentId`, and assign each agent to their
own. For each extra agent, copy
`call-center/call-center-definition.xml`, change its **InternalName**,
**Display Name** and the `agentId` in the adapter URL, and import the copy.

Every agent on the same Vobiz account needs a **different `agentId`** — the
`agentId` decides which SIP endpoint an agent gets, so two agents sharing one
would take each other's calls. Agents on different Vobiz accounts can reuse a
value.

---

## Using it

### Make a call

Wait for the status badge to turn green. The **Call** button stays disabled
until the panel is both signed in and registered, and the hint under it says
which is missing.

Then type a number in E.164 format and click **Call**, or click any phone
number in Salesforce — the panel opens and dials it. Click **Hang up** to end
the call.

The first call asks for **microphone** permission. Allow it, or the other side
hears nothing.

If the other side is busy or rejects the call, it ends straight away. If
nobody answers, it ends after `OUTBOUND_RING_SECONDS` (45 by default).

### Receive a call

After **Enable inbound calls** (account sign-in), a call to your number:

1. Rings every open panel signed in to that Vobiz account. The caller hears
   "Please hold while we connect you."
2. The panel plays a ringtone, shows the caller's number, and opens their
   record in Salesforce.
3. **Accept** (or <kbd>Enter</kbd>) connects you. **Decline** (or
   <kbd>Esc</kbd>) sends the caller to voicemail. The first agent to accept
   takes the call; it stops ringing everywhere else.
4. If nobody accepts within `INBOUND_RING_SECONDS` (45 by default), the caller
   goes to voicemail.

The caller goes **straight to voicemail** when no panel of that account is
listening — the Salesforce tab is closed, or every agent is already on a call
or being rung. If nobody from that account has signed in since the backend
started, the caller hears "Sorry, this number cannot take calls right now" and
the call ends.

Keep **one** Salesforce tab with the panel open. Several tabs register the same
phone line and replace each other.

### Call logging

When a call ends, the panel writes a completed **Task** to Salesforce, so the
call appears in the record's Activity History next to your other logged calls.

| Task field | Value |
|---|---|
| Subject and Comments | `Vobiz call to +91XXXXXXXXXX` or `Vobiz call from +91XXXXXXXXXX`, with `(no answer)`, `(missed)` or `(declined)` added when nobody talked |
| Call Type | `Outbound` or `Inbound` |
| Call Duration | Talk time in seconds. For an outbound call it starts when the other person answers, not when you click **Call**, so ringing is not counted. For an inbound call it starts when you accept. A call nobody answered is logged as 0. |
| Call Result | `No answer` (outbound), `Missed` or `Declined` (SIP direct inbound) when nobody talked; empty otherwise |
| Status | `Completed` |
| Due Date | The day of the call |
| Name or Related To | The matched record: a **Contact** or **Lead** as **Name**, anything else (an Account, for example) as **Related To** |

**How the record is matched (screen pop).** A click-to-dial uses the record you
clicked. A typed number, and an inbound caller's number, are searched in
Salesforce when the call starts: one match opens automatically; several leave
Salesforce's search results on screen for you to choose; no match logs the Task
with no related record.

A Salesforce error never interrupts a call. If the search or the Task write
fails, the call carries on and the panel returns to **Ready**.

### Recordings

Tick **Record this call** before you click **Call**. For an inbound call, tick
it before you click **Accept**; recording starts when you join, so the caller's
time on hold is not in the file. Recorded calls are billed by Vobiz.

Recordings — and voicemail messages — are stored in your Vobiz account. Play
or download them in the **Vobiz Console → Voice → Recordings**. The panel and
the backend do not list or serve recordings.

---

## Configuration reference

### Backend (`backend/.env` or environment variables)

The backend reads these, and nothing else. There are no Vobiz credentials in
its configuration.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | **Yes** | — | The public `https://` address Vobiz and Salesforce reach the backend at, without a trailing slash. Every webhook URL given to Vobiz is built from it. The backend will not start without it. |
| `PORT` | No | `8080` | Port the server listens on. |
| `DATA_DIR` | No | `backend/data` | Folder for `endpoints.json`, the map of which SIP endpoint belongs to which agent. |
| `SALESFORCE_FRAME_ANCESTORS` | No | `https://*.lightning.force.com https://*.my.salesforce.com https://*.force.com` | Which sites may frame the panel (the `frame-ancestors` policy). |
| `REQUIRE_VOBIZ_SIGNATURE` | No | `false` | `true` refuses any webhook that arrives without a Vobiz signature. Signed webhooks are always checked. |
| `INBOUND_RING_SECONDS` | No | `45` | How long an inbound call rings the panels before voicemail. For SIP direct, how long the endpoint rings. |
| `OUTBOUND_RING_SECONDS` | No | `45` | How long an outbound destination rings before the call is given up. |
| `SESSION_HOURS` | No | `12` | How long a panel sign-in lasts before the agent signs in again. |
| `VOBIZ_API_BASE` | No | `https://api.vobiz.ai` | The Vobiz API address. Leave unset unless Vobiz support tells you otherwise. |

### Panel (CTI Adapter URL parameters)

Salesforce has no settings screen for an Open CTI panel, so its settings are
query parameters on the **CTI Adapter URL**. Type a plain `&` between them in
Salesforce (the `&amp;` in the XML file is only XML escaping).

| Parameter | Required | Default | Meaning |
|---|---|---|---|
| `org` | **Yes** | Derived from the page framing the panel | Your My Domain URL, e.g. `https://your-org.my.salesforce.com`. The panel loads Salesforce's Open CTI toolkit from it, and accepts only Salesforce hosts. |
| `agentId` | **Yes** | — | This agent's identity: 1–40 letters, digits, `-` or `_`. Different for every agent on the same Vobiz account. |
| `registrarUrl` | No | `wss://registrar.vobiz.ai:5063/` | The Vobiz SIP registrar. Must be a `wss://` address on `vobiz.ai`. Leave unset unless Vobiz support tells you otherwise. |
| `apiVersion` | No | `64.0` | The Open CTI API version to load, such as `62.0`. |

---

## Deploying to production

- **HTTPS on a stable hostname.** Salesforce stores the adapter URL and Vobiz
  stores the answer URLs, all built from `PUBLIC_BASE_URL`. If the hostname
  changes, update `PUBLIC_BASE_URL`, the Call Center adapter URLs and the
  Trusted URL, and have agents sign in again (the backend then finds or creates
  a `VobizSF` application for the new address). Point any SIP direct
  applications at the new address yourself.
- **Run one instance.** Sessions, signed-in accounts and calls in progress are
  held in the memory of one process. Do not run several instances behind a
  load balancer.
- **Restarts sign everyone out.** After a restart or redeploy, every agent signs
  in again. Until someone from an account has, that account's outbound calls
  are refused and its inbound callers hear "this number cannot take calls right
  now". Deploy outside working hours.
- **Keep `DATA_DIR` on persistent storage.** It holds `endpoints.json` (endpoint
  ids and usernames, no passwords or tokens). If it is lost, the backend finds
  each agent's endpoint again by its alias, so this is a convenience rather than
  a hard requirement — but keep it, and keep it private.
- **Require signed webhooks** once you have confirmed your Vobiz account signs
  them: `REQUIRE_VOBIZ_SIGNATURE=true`.
- **Keep the process running** with your platform's service manager (systemd, a
  container restart policy, or similar). `GET /healthz` returns `{"ok":true}`
  for health checks.
- **Salesforce side.** Nothing to package or upload. Scope the Trusted URL to
  your exact backend origin, not a wildcard, and create one Call Center per
  agent.

---

## Security and privacy

- **Your Auth Token never reaches the browser and is never stored on disk.**
  The agent types it once; the backend uses it to call Vobiz, keeps it in
  memory only, and never logs it or sends it back.
- **What the backend stores on disk:** only `DATA_DIR/endpoints.json` — which
  endpoint id and SIP username belong to which agent of which account. The file
  is created readable by the server's user only. No passwords, tokens or call
  data.
- **What the browser receives:** the agent's SIP username and a SIP password
  that is replaced on every sign-in, the account's phone numbers, and an
  `HttpOnly` session cookie the panel's code cannot read. The SIP password goes
  only to the Vobiz registrar.
- **What the browser stores:** nothing on the Vobiz account tab. On the SIP
  direct tab, only if the agent ticks **Remember these**: that endpoint's
  username, password and caller ID, in this browser's local storage. Leave it
  unticked on a shared computer.
- **Requests from other sites are refused.** The backend accepts panel requests
  only as JSON from its own origin and sends no CORS headers, so another web
  page cannot use an agent's session.
- **Only an agent's own phone line can spend their account.** The backend
  places a call only for the SIP endpoint it gave to a signed-in agent, and only
  on that agent's account.
- **Webhook signatures.** Signed Vobiz webhooks (`X-Vobiz-Signature-V3`, or
  `-V2`) are verified with the Auth Token of the account they belong to, and a
  bad signature is refused. Set `REQUIRE_VOBIZ_SIGNATURE=true` to refuse
  unsigned ones too. Webhooks for SIP direct calls cannot be verified, because
  the backend holds no token for them.
- **Only Salesforce can frame the panel**, through the `frame-ancestors`
  policy (`SALESFORCE_FRAME_ANCESTORS`).
- **Recordings are not served.** There are no recording links to leak; play
  recordings in the Vobiz Console.
- **The adapter URL is not secret.** Any Salesforce admin can read it, so it
  carries no credentials by design. The panel checks every parameter on it:
  `org` must be a Salesforce host and `registrarUrl` a Vobiz host. There is no
  parameter for the backend's address: the panel only ever talks to the
  origin that served it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Troubleshooting

Keep the browser's developer console open while you set up: every failure is
logged there with a specific message.

| Symptom | Cause | Fix |
|---|---|---|
| The phone panel is blank, or the console shows a `frame-src` error | The backend's origin is not a Trusted URL with `frame-src`, or the adapter URL is plain HTTP | Add the Trusted URL ([Quick start](#quick-start) step 5) and use `https://` |
| No **Phone** item in the utility bar | The user is not assigned to the Call Center, or the utility item is missing | **Manage Call Center Users**; add **Open CTI Softphone** in App Manager |
| A change to the adapter URL has no effect | Salesforce caches it | Hard-refresh: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> |
| "Salesforce org not known" | `org` is missing from the adapter URL, or is not a Salesforce host | Add `?org=https://your-org.my.salesforce.com` |
| "Not configured — set the Backend URL and Agent Identity" | `agentId` is missing from the adapter URL | Add `&agentId=<agent>` |
| "Cannot reach the calling backend" | The backend is down, or the panel is served from somewhere other than the backend | Check `https://calling.example.com/healthz`; serve the panel from the backend (`/salesforce/softphone.html`) |
| "Vobiz rejected that Auth ID and Auth Token" | Wrong or stale credentials | Copy both again from Console → API credentials. The Auth Token is not your login password |
| "Logged in … this account has no phone numbers yet" and **Call** stays disabled | The account has no active, voice-enabled number | Buy or activate a number in the Vobiz Console, then log in again |
| The badge is green but calls end with "Please sign in to the softphone again" | The backend restarted, or the session expired (`SESSION_HOURS`) | Sign in again on the **Vobiz account** tab |
| The call connects but there is no audio, and no microphone prompt appeared | Salesforce is blocking the microphone in its frame | Tick **microphone** on the Trusted URL; if greyed out, set Session Settings → Browser Feature Permissions → Microphone to **Trusted URLs Only** first |
| Inbound callers go straight to voicemail | No panel of that account was listening | Keep the Salesforce tab with the panel open and signed in; check the agent is not already on a call |
| Inbound callers hear "this number cannot take calls right now" | Nobody from that account has signed in since the backend started, or (SIP direct) no agent is signed in with that number as **Calling from** | Have an agent sign in |
| Inbound calls do not reach the panel at all | The number is not attached to the integration's application | Click **Enable inbound calls** (account sign-in), or attach the number to your application (SIP direct) |
| SIP direct: "Vobiz rejected these credentials" | Wrong SIP username or password | Set a new password on the endpoint in the Console and use that |
| SIP direct: calls fail as soon as they start | The endpoint is not attached to an application whose answer URL is `<PUBLIC_BASE_URL>/answer`, or **Calling from** is not a number on that account | Follow the [SIP direct](#sip-direct) setup |
| Every call fails and the backend logs "signature invalid" | `PUBLIC_BASE_URL` does not match the address Vobiz was given | Set `PUBLIC_BASE_URL` to the exact public address, restart, and sign in again |
| Calls take several seconds to connect | Many virtual network adapters (VPN, Docker) on the agent's machine | Disconnect unused VPNs or adapters |

---

## Limitations

- **Sign in again after the backend restarts.** Sessions are held in memory.
- **Run one backend instance.** State is not shared between processes.
- **Two Vobiz call records (CDRs) per call**, one per leg, because every call
  is a conference. Keep this in mind when you reconcile call records.
- **One agent per Call Center.** More agents need more Call Center records.
- **One Salesforce tab per agent** with the panel open.
- **One inbound call per agent at a time.** A second caller while the agent is
  ringing or on a call goes to voicemail; there is no queue.
- **Browser calling only.** Calls cannot be sent to a mobile or desk phone.
- **No hold, mute, transfer or conferencing** between agents.
- **Calls are logged as Tasks**, not Salesforce Voice Call records (those
  require Service Cloud Voice).
- **No omnichannel presence.** The panel does not set agent availability.
- **Recordings and voicemails are only in the Vobiz Console**, not in the panel
  or in Salesforce.
- **SIP direct:** no caller ID dropdown, no **Enable inbound calls**, and
  inbound calls cannot be recorded and get no voicemail.
- **The panel must be served by the backend.** It talks only to the origin it
  was loaded from; a backend on another origin is not supported.
- **Inbound is set up per number** from the currently selected caller ID; to
  route several numbers, select each and click **Enable inbound calls** for
  each.

---

## Development

```bash
npm test                      # the test suite; no Vobiz account or network needed
npm run check-docs            # checks every link in the Markdown docs
node --check backend/server.js   # syntax check; also app/softphone.js, app/opencti-host.js
```

There is no build step and no framework. Edit a file, restart the backend if
you changed `backend/`, and hard-refresh Salesforce. CI runs the tests, the
docs link check, an XML check of the Call Center definition, and a scan for
committed credentials.

| Path | What it is |
|---|---|
| `app/softphone.html`, `app/style.css` | The panel |
| `app/softphone.js` | Sign-in, dialling, inbound ringing, screen pop and Task logging |
| `app/opencti-host.js` | The Salesforce layer: loads Open CTI and checks the adapter URL parameters |
| `app/lib/jssip.min.js` | The SIP library (JsSIP), included |
| `backend/server.js` | The calling backend, which also serves the panel |
| `backend/.env.example` | Configuration template |
| `call-center/call-center-definition.xml` | The Call Center definition to import |
| `docs/install.md` | The Salesforce setup, step by step |
| `docs/architecture.md` | How the call flows work |
| `docs/backend-contract.md` | Every endpoint the panel needs, for building your own backend |
| `tests/` | The test suite |
| `tools/check-docs.mjs` | The documentation link checker |

To build your own backend instead of using `backend/`, implement
[docs/backend-contract.md](docs/backend-contract.md), including its security
requirements. See also [backend/README.md](backend/README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Support and links

- Integration guide: https://www.vobiz.ai/docs/integrations/salesforce
- Vobiz documentation: https://www.vobiz.ai/docs
- Vobiz Console: https://console.vobiz.ai
- Support: [support@vobiz.ai](mailto:support@vobiz.ai)
- Security reports: [SECURITY.md](SECURITY.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)

Licensed under the [MIT Licence](LICENSE), © 2026 Vobiz. This is an official
Vobiz integration, not a Salesforce product. Salesforce, Lightning, Open CTI and
Service Cloud are trademarks of Salesforce, Inc., used here only to describe
compatibility.
