# Distribution

**Nothing here needs a listing.** Open CTI is configuration, not a package: an
admin creates a Call Center, points it at a URL, and assigns users. There is no
package to upload, no security review to pass, and no AppExchange step between
you and a working phone. That is the main reason this integration is built on
Open CTI rather than as a managed package.

So this document exists for one question only: *what would change if you ever
did want an AppExchange listing.*

---

## What a listing would require that this does not have

- [ ] **A managed package.** AppExchange distributes packages, not URLs. The
      Call Center definition, and anything else an admin configures by hand
      today, would have to move into one.
- [ ] **A Salesforce Partner account** and a Partner Business Org to package
      from.
- [ ] **Security Review.** Salesforce reviews the package and anything it talks
      to. The calling backend is in scope: it holds the Vobiz Auth Token and
      serves the panel, so its authentication, CORS and recording handling all
      get looked at. [docs/backend-contract.md](docs/backend-contract.md#security-requirements)
      is the list to have satisfied before submitting, not after.
- [ ] **A vendor-hosted backend at a stable hostname.** A listed app cannot ask
      every customer to run their own service on a tunnel, which is what the
      contract assumes today. This is the same decision the other Vobiz CRM
      integrations face, and it is a product decision before it is an
      engineering one: one multi-tenant backend means real per-account
      authentication, not one account's credentials in a `.env`.
- [ ] **Per-agent identity.** One Call Center definition per agent does not
      survive contact with a real org. A listed app needs the agent's Salesforce
      identity to select the SIP endpoint, rather than an `agentId` typed into a
      URL.
- [ ] Listing assets, a Terms of Service and a Privacy Policy, and test org
      credentials for the reviewer.

## What is already in the right shape

- [x] No credentials in the repository, and none shipped to the browser beyond
      what an agent explicitly asks to remember.
- [x] The panel holds no Auth Token; it is a backend concern by design.
- [x] `?org=` is validated against Salesforce's own domains before any script is
      loaded from it.
- [x] Recordings are deliberately not served by the panel.
- [x] Standard objects only — calls are logged as Tasks, so they appear in
      Activity History like any other logged call, with no custom object to
      package.
- [x] MIT licensed, with the trademark position stated in the README.

---

## Until then

The supported path is the one in [docs/install.md](docs/install.md): host the
panel, trust the origin, import the Call Center definition, assign users. For a
customer that is five minutes of admin work and no review queue — which for most
deployments is the better trade, and worth saying out loud before anyone spends
a quarter on packaging.
