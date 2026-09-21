# Contributing

## Before changing the panel

`app/softphone.js` is generated from the Freshsales panel by
`tools/port-from-freshsales.mjs`. **Telephony fixes belong there, not here** —
the conference bridge, ICE handling, SIP registration and inbound flow are
shared across every Vobiz CRM integration, and a fix made in one should reach
the others by re-running the port rather than being written again.

Salesforce's own code is:

- `app/opencti-host.js` — the host adapter
- the CRM functions at the bottom of `app/softphone.js` — `findContact` and
  `logCallToCrm`

Those are the two places a Salesforce-specific change belongs.

## Testing a change

There is no build step. Serve `app/` over HTTPS, point a Call Center at it, and
hard-refresh Salesforce — it caches the adapter URL.

Keep the browser console open. Every failure mode this app has hit names itself
there, and the message is more specific than anything Salesforce shows.

Please verify, at minimum:

1. Sign in on **both** tabs — account and SIP direct.
2. An outbound call with audio **both ways**. Make two; media problems here have
   historically been intermittent.
3. An inbound call: ring, Accept, talk, hang up — and confirm the caller's phone
   actually drops.
4. Click-to-dial from a record page.

## Reporting a problem

Please include:

- The **hangup cause code** from the Vobiz CDR — the number, not the name. The
  name is frequently `NORMAL_CLEARING` on calls that plainly did not clear
  normally.
- The **packet loss and MOS** from the CDR for both legs. A clean browser leg
  next to a lossy phone leg is a specific, known signature.
- The browser console, filtered to `Vobiz`.
- A UTC timestamp, so it can be correlated against Vobiz's logs.

And please keep account identifiers, endpoint usernames, phone numbers and
backend hostnames out of this repository — use placeholders.
