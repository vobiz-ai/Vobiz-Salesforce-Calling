# Installing in Salesforce

Every step here is in Salesforce Setup. There is nothing to package, upload or
submit for review — Salesforce stores a URL and frames whatever is at it.

Budget about twenty minutes, assuming the panel is already hosted.

---

## Before you start

- **Salesforce** with admin access. Lightning Experience. A Developer Edition
  org is fine for evaluation.
- **The panel hosted at a public HTTPS URL.** See the README's
  [Hosting the panel](../README.md#3-host-the-panel) section.
- **A calling backend**, reachable over HTTPS by both Vobiz and the browser.
  See [backend-contract.md](backend-contract.md).

Have your **My Domain host** to hand — the `https://<something>.my.salesforce.com`
address. Find it at Setup → **My Domain**. It is not the `lightning.force.com`
address you browse.

---

## Step 1 — Trust the host that serves the panel

Salesforce refuses to frame anything that is not on its Trusted URLs list, and
the failure is a blank panel with a CSP error in the browser console.

1. Setup → Quick Find → **Trusted URLs** → **New Trusted URL**
2. Fill in:

   | Field | Value |
   |---|---|
   | API Name | `Vobiz_Calling` |
   | URL | the origin serving the panel, e.g. `https://calling.example.com` |
   | Active | ticked |
   | CSP Context | **All** |

3. Under **CSP Directives**, tick **`frame-src`**. This is the one that matters;
   without it nothing loads. Tick `connect-src` as well.
4. **Save.**

> **A wildcard is allowed** — `https://*.example.com` — and is worth using if the
> host changes, as a development tunnel does.

### Microphone access

Salesforce can also block the microphone inside its frame, which produces a call
that connects with no audio and no permission prompt.

On the same Trusted URL, scroll to **Permissions Policy Directives** and tick
**microphone**. If it is greyed out, set **Microphone** to *Trusted URLs Only*
first, under Setup → **Session Settings** → Browser Feature Permissions.

---

## Step 2 — Create the Call Center

1. Setup → Quick Find → **Call Centers**.
   If a splash screen appears, click **Continue**.
2. Click **Import**, choose
   [`call-center/call-center-definition.xml`](../call-center/call-center-definition.xml),
   and import it.
3. Open the imported **Vobiz Calling** record and click **Edit**.
4. Set **CTI Adapter URL** to your own, with its parameters:

   ```
   https://calling.example.com/salesforce/softphone.html?org=https://your-org.my.salesforce.com&agentId=agent-one
   ```

   | Parameter | Required | What it is |
   |---|---|---|
   | `org` | yes | Your My Domain host. Open CTI is served per-org; there is no CDN copy. |
   | `agentId` | yes | Which identity this call centre registers as. **Every agent needs a different value.** |
   | `backendUrl` | no | Defaults to wherever the panel is served from. |
   | `apiVersion` | no | Open CTI version, default `64.0`. |

5. **Save.**

> Type a plain `&` between parameters in this field. The `&amp;` in the XML file
> is only because XML requires it.

---

## Step 3 — Assign your users

Without this the phone never appears, and nothing says why.

1. On the Call Center record, click **Manage Call Center Users**
2. **Add More Users** → search → select → **Add to Call Center**

---

## Step 4 — Put the phone in the utility bar

1. Setup → **App Manager**
2. Find your Lightning app — **Service Console** is the usual one — and choose
   **Edit** from its row menu
3. **Utility Items (Desktop Only)** → **Add Utility Item** → **Open CTI Softphone**
4. Set the panel height to at least **600** and width to **400**
5. **Save**

---

## Step 5 — Open it

1. Open the app you just edited
2. **Hard-refresh** — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>. Salesforce
   caches the adapter URL, and a normal refresh will keep using the old one.
3. Click **Phone** at the bottom left

You should see the Vobiz panel: a status badge, **Vobiz account** and **SIP
direct** tabs, and numbered steps.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| **"This content is blocked"**, or a CSP `frame-src` error in the console | Step 1 was missed, or the URL does not match the trusted entry. |
| **`frame-ancestors 'none'`** in the console | The adapter URL points at a Salesforce page rather than the panel. |
| A warning page instead of the panel | The host is showing a browser interstitial. ngrok's free tier does this and a frame cannot suppress it — use a host that does not. |
| **"Salesforce org not known"** | `?org=` is missing from the adapter URL and could not be derived. |
| **"Not configured"** | `?agentId=` is missing. |
| **"Cannot reach the calling backend"** | The backend is down, or its CORS does not admit the panel's origin. |
| Panel loads, no phone icon | The user is not assigned — step 3. |
| Call connects, no audio, no mic prompt | Microphone permission — the note in step 1. |

Keep the browser console open while testing. Every failure above names itself
there, and the message is more specific than anything Salesforce shows on screen.
