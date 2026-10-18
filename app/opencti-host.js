/** === Salesforce Open CTI host adapter ===
 *
 * The panel (softphone.js) reaches its host through a small `app`/`client`
 * object: read settings, listen for click-to-dial, show a record. This file
 * supplies that object, backed by Salesforce's Open CTI toolkit.
 *
 * Configuration cannot come from installation settings here. Salesforce stores
 * only an adapter URL and gives it no settings UI, so everything is read from
 * that URL's query string. See README.md → Configuration.
 *
 * Every value read from the query string is untrusted: anyone can send an agent
 * a link to the panel with parameters of their choosing. So each one that names
 * a place to load code from, send credentials to, or register with is checked
 * before it is used.
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

/**
 * The Open CTI API version, which becomes part of the toolkit's path.
 *
 * Checked as strictly as the host. Unchecked, `apiVersion=../../../x` walks out
 * of /support/api/ and loads any file from any Salesforce host — including a
 * file an attacker uploaded to their own free org — which is the same script
 * execution the host check exists to prevent.
 */
const API_VERSION = /^\d{2,3}\.0$/;

function toolkitUrl() {
  const explicit = (PARAMS.get("org") || "").trim().replace(/\/+$/, "");
  const apiVersion = (PARAMS.get("apiVersion") || "64.0").trim();
  if (!API_VERSION.test(apiVersion)) {
    console.error(`[Vobiz] refusing apiVersion=${apiVersion} — expected a version such as 64.0`);
    return null;
  }
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

/** True when Salesforce is the page framing this panel. */
function framedBySalesforce() {
  try {
    if (window.top === window.self) return false;
    return SALESFORCE_HOST.test(new URL(document.referrer).hostname);
  } catch {
    return false;
  }
}

const DEFAULT_REGISTRAR = "wss://registrar.vobiz.ai:5063/";
/** Vobiz's own registrars only. The SIP password is presented to this host. */
const VOBIZ_REGISTRAR = /^wss:\/\/[a-z0-9.-]+\.vobiz\.ai(:\d+)?\/?$/i;

/**
 * Where the agent's Auth Token and SIP password are sent.
 *
 * The default — the origin that served this page — needs no checking. An
 * override does: a link carrying `backendUrl=https://evil.example` would
 * otherwise collect whatever the agent types into the sign-in form, on a page
 * that is genuinely yours. So an override is honoured only when Salesforce is
 * framing the panel, which is the one place an admin-set adapter URL is loaded.
 */
function backendUrl() {
  const own = window.location.origin;
  const override = (PARAMS.get("backendUrl") || "").trim();
  if (!override) return own;
  let origin;
  try {
    origin = new URL(override).origin;
  } catch {
    console.error(`[Vobiz] ignoring backendUrl=${override} — not a URL`);
    return own;
  }
  if (origin === own) return override;
  if (!framedBySalesforce()) {
    console.error(`[Vobiz] ignoring backendUrl=${override} — an override is only honoured inside Salesforce`);
    return own;
  }
  return override;
}

function registrarUrl() {
  const value = (PARAMS.get("registrarUrl") || "").trim();
  if (!value) return DEFAULT_REGISTRAR;
  if (!VOBIZ_REGISTRAR.test(value)) {
    console.error(`[Vobiz] ignoring registrarUrl=${value} — it must be a wss:// address on vobiz.ai`);
    return DEFAULT_REGISTRAR;
  }
  return value;
}

const HOST = {
  iparams: {
    get: async () => ({
      // Defaults to wherever this page was served from, which is the calling
      // backend in the recommended setup — so the common case needs no
      // parameter at all. Override with ?backendUrl= when hosting the panel
      // somewhere other than the backend.
      backend_url: backendUrl(),
      agent_id: PARAMS.get("agentId") || "",
      registrar_url: registrarUrl(),
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

  // CRM writes go through Open CTI directly (see the bottom of softphone.js),
  // so the host offers no request proxy. Anything reaching for one should fail
  // loudly rather than quietly at runtime.
  request: {
    invokeTemplate() {
      return Promise.reject(new Error("no request proxy here — use Open CTI"));
    },
  },
};

const app = { initialized: async () => HOST };
