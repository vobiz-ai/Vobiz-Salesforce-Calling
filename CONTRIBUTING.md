# Contributing

Bug reports, questions and pull requests are welcome.

## Reporting a problem

Open an issue with: what you did, what happened, and what you expected. For
anything call-related, the **browser console** is the useful log — every failure
mode in the panel names itself there, and the message is more specific than
anything Salesforce shows on screen. Include it.

For a security problem, do not open an issue — see [SECURITY.md](SECURITY.md).

## Working on the panel

There is no build step and no framework. The panel is four files in `app/` plus
a vendored copy of JsSIP.

```bash
npx serve app     # or any static server that speaks HTTPS
```

Salesforce will not frame a plain-HTTP origin, so local work needs a tunnel or a
certificate, and it must not show a browser interstitial — a frame cannot
suppress one, and Salesforce shows a blank panel instead. Point a Call Center at
it and hard-refresh Salesforce after every change; there is nothing to rebuild.

[docs/install.md](docs/install.md) has the Salesforce-side walkthrough and
[docs/architecture.md](docs/architecture.md) explains how the pieces fit
together.

## What the code is

- `app/opencti-host.js` — the Salesforce integration layer, over the Open CTI
  toolkit
- `app/softphone.js` — sign-in, dialling, call handling, and the CRM lookups at
  the bottom of the file
- `app/softphone.html`, `app/style.css` — the panel itself

If you change how the panel talks to a backend, keep
[docs/backend-contract.md](docs/backend-contract.md) in step. Anyone running
this has implemented that document, and a contract that drifts from the code
breaks their install rather than ours.

## Pull requests

1. Say what you changed and how you tested it. For anything touching call flow,
   that means a real call in both directions.
2. Keep [CHANGELOG.md](CHANGELOG.md) current for anything a user would notice.
3. CI checks that the JavaScript parses, that documentation links resolve, and
   that no credential is committed. It runs on every pull request.
