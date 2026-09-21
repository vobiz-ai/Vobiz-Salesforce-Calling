/** === Salesforce Open CTI host adapter ===
 *
 * The panel this loads alongside is the Freshsales panel, ported across almost
 * unchanged. It reaches its host through an `app`/`client` pair shaped like the
 * Freshworks SDK; this file supplies that same shape backed by Salesforce's
 * Open CTI toolkit instead.
 *
 * Done this way so the two integrations do not drift. Everything hard-won in
 * that panel — the conference bridge, the ICE gathering cap, the
 * placeholder-password gate, releasing a caller's leg on hangup — is telephony,
 * not CRM, and none of it should be reimplemented per platform. A fix made in
 * one ports to the other by copying a function; see tools/port-from-freshsales.mjs.
 *
 * Configuration cannot come from installation settings here. Salesforce stores
 * only an adapter URL and gives it no settings UI, so everything is read from
 * that URL's query string. See README.md → Configuration.
 */
const PARAMS = new URLSearchParams(window.location.search);

/**
 * Where to load Salesforce's Open CTI toolkit from.
 *
 * There is no CDN copy: every org serves its own, and loading another org's
 * does not work. So the org host has to be supplied, and it is not hardcoded
 * here because this file ships to whoever installs it.
 *
 * `?org=` is the supported way. The fallback derives it from the page that
 * framed us, which is correct in ordinary Lightning use — Salesforce serves the
 * UI from `<org>.lightning.force.com` and the toolkit from
 * `<org>.my.salesforce.com` — but the parameter is what to rely on.
 */
/**
 * Only Salesforce's own hosts may serve the toolkit.
 *
 * `?org=` names a host this page then loads a script from, so an unchecked
 * value is script execution on whichever origin serves the panel — which, in
 * the recommended setup, is the calling backend. An admin sets the adapter URL,
 * but nothing stops an agent being sent a link to the panel with someone else's
 * `org=` on it. The referrer-derived fallback below has always checked the
 * hostname; the explicit parameter has to be held to the same rule.
 */
const SALESFORCE_HOST = /^[a-z0-9][a-z0-9.-]*\.(my\.salesforce\.com|salesforce\.com|force\.com|salesforce-setup\.com)$/i;

function toolkitUrl() {
  const explicit = (PARAMS.get("org") || "").trim().replace(/\/+$/, "");
  const apiVersion = (PARAMS.get("apiVersion") || "64.0").trim();
  const path = `/support/api/${apiVersion}/lightning/opencti_min.js`;

  if (explicit) {
    // A bare host is accepted too — `org=acme.my.salesforce.com` is an easy
    // thing to paste into a Call Center definition, and it parses as nothing
    // at all without a scheme.
    const withScheme = /^https?:\/\//i.test(explicit) ? explicit.replace(/^http:\/\//i, "https://") : `https://${explicit}`;
    let host;
    try {
      host = new URL(withScheme).hostname;
    } catch {
      host = "";
    }
    if (!SALESFORCE_HOST.test(host)) {
      console.error(`[Vobiz] refusing to load the Open CTI toolkit from ${explicit || "(empty)"} — ?org= must name a Salesforce host`);
      return null;
    }
    return `https://${host}${path}`;
  }

  try {
    const framer = new URL(document.referrer);
    if (/\.lightning\.force\.com$/i.test(framer.hostname)) {
      return `https://${framer.hostname.replace(/\.lightning\.force\.com$/i, ".my.salesforce.com")}${path}`;
    }
    if (/\.my\.salesforce\.com$/i.test(framer.hostname)) return `https://${framer.hostname}${path}`;
  } catch { /* no referrer, or not a URL — fall through */ }

  return null;
}

/**
 * Loaded at runtime rather than with a <script> tag in the markup, because the
 * URL is not known until the query string has been read. Everything that needs
 * `sforce` waits on this, so nothing has to care that it arrives late.
 */
const TOOLKIT_READY = new Promise((resolve, reject) => {
  const src = toolkitUrl();
  if (!src) {
    reject(new Error(
      "Salesforce org not known. Append ?org=https://your-org.my.salesforce.com " +
      "to this app's CTI Adapter URL — see README.md → Configuration.",
    ));
    return;
  }
  const tag = document.createElement("script");
  tag.src = src;
  tag.onload = () => resolve();
  tag.onerror = () => reject(new Error(`Could not load the Open CTI toolkit from ${src}`));
  document.head.appendChild(tag);
});

/**
 * Promisify one Open CTI call.
 *
 * Every method in the toolkit takes a `callback` receiving
 * {success, returnValue, errors} rather than returning anything, so each one
 * needs this wrapper. Awaiting TOOLKIT_READY first means callers never have to
 * think about load order.
 */
async function openCti(method, args = {}) {
  await TOOLKIT_READY;
  return new Promise((resolve, reject) => {
    if (typeof sforce === "undefined" || !sforce.opencti || !sforce.opencti[method]) {
      reject(new Error(`Open CTI has no method ${method} — check the apiVersion`));
      return;
    }
    sforce.opencti[method]({
      ...args,
      callback: result => {
        if (result && result.success) resolve(result.returnValue);
        else reject(new Error((result && JSON.stringify(result.errors)) || `${method} failed`));
      },
    });
  });
}

const HOST = {
  iparams: {
    get: async () => ({
      // Defaults to wherever this page was served from, which is the calling
      // backend in the recommended setup — so the common case needs no
      // parameter at all. Override with ?backendUrl= when hosting the panel
      // somewhere other than the backend.
      backend_url: PARAMS.get("backendUrl") || window.location.origin,
      agent_id: PARAMS.get("agentId") || "",
      registrar_url: PARAMS.get("registrarUrl") || "wss://registrar.vobiz.ai:5063/",
    }),
  },

  events: {
    /**
     * Click-to-dial, which Salesforce delivers in two steps rather than one.
     *
     * Phone numbers in Salesforce are not clickable until a softphone asks for
     * it, so enabling comes first and the listener is registered inside its
     * callback — registering before the enable call has completed silently
     * receives nothing.
     */
    on(name, handler) {
      if (name !== "calling") return;
      openCti("enableClickToDial")
        .then(() => {
          sforce.opencti.onClickToDial({
            listener: payload => {
              // Documented as both a plain object and a JSON string across
              // toolkit versions, so read both rather than depending on which
              // one a given org serves.
              let data = payload || {};
              if (typeof data.result === "string") {
                try { data = { ...data, ...JSON.parse(data.result) }; } catch { /* not JSON */ }
              }
              // Re-shaped into the event the panel already expects, so the
              // panel never has to know which CRM it is running in.
              handler({
                data: {
                  phoneNumber: data.number || data.phoneNumber,
                  recordId: data.recordId,
                  objectType: data.objectType,
                },
              });
            },
          });
        })
        .catch(err => console.warn("[Vobiz] click-to-dial unavailable:", err.message));
    },
  },

  interface: {
    /**
     * The panel asks its host to show one of two things: itself, or a record.
     * Rejecting is meaningful rather than fatal — the panel treats a refusal as
     * "this host does not do that" and carries on.
     */
    trigger(action, payload) {
      if (action !== "show") return Promise.reject(new Error(`unsupported action ${action}`));
      if (payload && payload.id === "contact" && payload.value) {
        return openCti("screenPop", {
          type: sforce.opencti.SCREENPOP_TYPE.SOBJECT,
          params: { recordId: payload.value },
        });
      }
      return openCti("setSoftphonePanelVisibility", { visible: true });
    },
  },

  // Deliberately absent: request.invokeTemplate. Freshworks proxies CRM writes
  // through templates declared in an app manifest; Salesforce has no equivalent,
  // and the panel's CRM functions are replaced with Open CTI ones rather than
  // shimmed. Anything still reaching for this is a porting mistake and should
  // say so loudly rather than fail quietly at runtime.
  request: {
    invokeTemplate() {
      return Promise.reject(new Error("request templates are Freshworks-only — use Open CTI here"));
    },
  },
};

const app = { initialized: async () => HOST };
