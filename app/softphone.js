/** === Vobiz Calling — Salesforce Open CTI softphone ===
 *
 * A softphone panel that lives in Salesforce's Open CTI utility item. It stays
 * registered over SIP for as long as the panel is open, starts a call when an
 * agent clicks a phone number anywhere in Salesforce, pops the matching record,
 * and writes a call Task when the call ends.
 *
 * app/opencti-host.js supplies the `app`/`client` object this file talks to,
 * backed by Open CTI. Every setting comes from the adapter URL's query string —
 * nothing about a particular account is compiled in.
 *
 * This app is a client. It cannot place a call on its own: it talks to a
 * calling backend that holds the Vobiz account credentials and drives the
 * Vobiz REST API. That contract is documented in docs/backend-contract.md, and
 * backend/ is a reference implementation of it.
 */
let BACKEND_URL = null;
let AGENT_ID = null;
let REGISTRAR_URL = null;

let client;
let vobizUA = null;
let currentRTCSession = null;

// Calling requires BOTH an account login (whose number/balance) and a live
// SIP registration (where the audio lands). Tracking them separately matters:
// gating the Call button on login alone lets an agent dial while SIP is down,
// and the browser places every call itself, so there is nothing to place it with.
let accountReady = false;
let sipRegistered = false;
// True only between an inbound leg arriving and it being accepted, declined or
// withdrawn. The keyboard shortcuts are gated on this.
let incomingPending = false;
/**
 * The caller waiting in a conference room, when there is one.
 *
 * Set by the backend poll rather than by a SIP INVITE, because Vobiz cannot
 * deliver an INVITE into a browser — see joinRoom, and the long note in the
 * backend. Null whenever nothing is ringing.
 */
let incomingOffer = null;
let inboundPollTimer = null;
/** A microphone taken while the banner rings, so Accept does not wait for one. */
let warmMicStream = null;

/**
 * Every backend call goes through here.
 *
 * ngrok's free tier serves a browser interstitial (ERR_NGROK_6024) to anything
 * with a browser User-Agent, which means a plain fetch() from this panel gets an
 * HTML warning page instead of JSON. The `ngrok-skip-browser-warning` header
 * suppresses it. It is inert against any other host, so it costs nothing once
 * the backend is on a real domain.
 */
function backendFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "ngrok-skip-browser-warning": "1", ...(options.headers || {}) },
  });
}

init();

async function init() {
  client = await app.initialized();

  const iparams = await client.iparams.get();
  BACKEND_URL = (iparams.backend_url || "").trim().replace(/\/+$/, "");
  AGENT_ID = (iparams.agent_id || "").trim();
  REGISTRAR_URL = (iparams.registrar_url || "wss://registrar.vobiz.ai:5063/").trim();

  if (!BACKEND_URL || !AGENT_ID) {
    setStatus("Not configured — set the Backend URL and Agent Identity in this app's settings.");
    return;
  }
  // A bare hostname would resolve relative to the panel's own origin and
  // 404 silently, which looks like "the backend is down" rather than a typo.
  // http://localhost is the one exemption: browsers already treat it as a
  // secure context, and the mock backend serves plain HTTP for local dev.
  const isLocalBackend = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BACKEND_URL);
  if (!/^https:\/\//i.test(BACKEND_URL) && !isLocalBackend) {
    setStatus("Backend URL must start with https:// — check this app's settings.");
    return;
  }

  client.events.on("calling", onTriggerDialer);
  document.getElementById("dialbtn").addEventListener("click", onDialButtonClick);
  document.getElementById("vobiz-login-btn").addEventListener("click", vobizLogin);
  document.getElementById("vobiz-number-select").addEventListener("change", vobizSelectNumber);
  document.getElementById("setup-inbound-btn").addEventListener("click", setupInboundCalling);
  document.getElementById("mode-account-tab").addEventListener("click", () => setAuthMode("account"));
  document.getElementById("mode-sip-tab").addEventListener("click", () => setAuthMode("sip"));
  document.getElementById("sip-connect-btn").addEventListener("click", sipDirectConnect);
  document.getElementById("hangupbtn").addEventListener("click", hangUp);
  document.getElementById("acceptbtn").addEventListener("click", acceptCall);
  document.getElementById("declinebtn").addEventListener("click", declineCall);

  // Enter and Escape while a call is ringing. An agent already reaching for the
  // keyboard should not have to find the mouse to pick up.
  // Gated on incomingPending rather than on the banner's hidden attribute: the
  // listener is on document, so it sees every keystroke in the panel, and
  // reading state back off the DOM makes it act on a banner some other code
  // put there.
  document.addEventListener("keydown", e => {
    if (!incomingPending) return;
    if (e.key === "Enter") { e.preventDefault(); acceptCall(); }
    else if (e.key === "Escape") { e.preventDefault(); declineCall(); }
  });

  // Leave the registrar cleanly. Without this the binding lingers until it
  // expires (JsSIP defaults to 600s) and inbound calls route to a dead leg
  // for up to ten minutes after the agent closes the tab.
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* nothing useful to do on the way out */ }
  });

  restoreAuthMode();
  // Account mode registers on its own, because the backend already knows which
  // identity this installation is. SIP direct cannot: nobody has typed the
  // credentials yet, so it waits for Connect (or restores a remembered sign-in).
  if (authMode !== "sip") {
    initVobizSip();
    restoreVobizSession();
  }
}

/** === Vobiz account login (Auth ID / Auth Token) ===
 * Separate from initVobizSip() above: that's the SIP identity used for a
 * future real agent bridge. This is which Vobiz *account* places the call —
 * whose number it goes out on, whose balance it bills to. Without logging
 * in here, /start-call is rejected by the backend; there is no more shared
 * fallback account.
 */
function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

/* ------------------------------------------------------------------ *
 * Two ways in
 *
 * "account"  Auth ID and Auth Token. The backend decides which SIP
 *            identity this installation is and hands it over, and it
 *            can list the account's numbers so the caller ID is a
 *            dropdown rather than something to be typed correctly.
 *
 * "sip"      The endpoint's own SIP username and password, typed here.
 *            Nothing account-wide is involved: the password goes only to
 *            the registrar, and the backend is told just the SIP username
 *            and caller ID, so it can route this endpoint's calls. The
 *            caller ID has to be typed, because listing the account's
 *            numbers is exactly the thing these credentials do not
 *            authorise. The endpoint and the number must already be
 *            attached to an application whose answer URL is this backend.
 *            Account features (number list, Enable inbound) say to sign
 *            in with the Vobiz account instead.
 *
 * Worth being plain about the trade: an endpoint password in the browser
 * is not a new exposure — the account path already sends one here, from
 * an endpoint that serves it to anyone who can reach the backend. This
 * path removes that endpoint from the picture rather than adding a risk.
 * ------------------------------------------------------------------ */

const AUTH_MODE_KEY = "vobiz.authMode";
const SIP_CREDS_KEY = "vobiz.sipDirect";
let authMode = "account";

/** localStorage is unavailable in a private window and throws rather than
 *  returning null, and losing a saved username is never worth a broken panel. */
function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* nothing to do; the panel works without it */ }
}

function setAuthMode(mode) {
  authMode = mode === "sip" ? "sip" : "account";
  writeStore(AUTH_MODE_KEY, authMode);

  const isSip = authMode === "sip";
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  };
  show("mode-account", !isSip);
  show("mode-sip", isSip);
  // Picking from the account's numbers needs account credentials, so in SIP
  // mode the caller ID is a field inside that panel instead.
  show("step-caller-id", !isSip);
  // Enable inbound attaches a number to an application — an account API call.
  show("setup-inbound-btn", !isSip);
  show("inbound-account-only", isSip);

  const tab = (id, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-selected", String(active));
  };
  tab("mode-account-tab", !isSip);
  tab("mode-sip-tab", isSip);
}

/** The caller ID to dial out as, when signed in as an endpoint. */
function sipDirectCallerId() {
  const el = document.getElementById("sip-caller-id");
  return el ? el.value.trim() : "";
}

/**
 * Sign in as one endpoint.
 *
 * Registration is all this does. There is no account session behind it, so the
 * caller ID cannot come from the backend and travels on each call instead —
 * see callHeaders().
 */
async function sipDirectConnect() {
  const username = (document.getElementById("sip-username") || {}).value?.trim() || "";
  const password = (document.getElementById("sip-password") || {}).value || "";
  const callerId = sipDirectCallerId();
  const remember = Boolean((document.getElementById("sip-remember") || {}).checked);

  if (!username || !password) {
    setLoginStatus("Enter the endpoint's SIP username and password.");
    return;
  }
  // Refused here rather than at dial time: carriers reject a call with no CLI,
  // and the failure that produces says nothing about a missing caller ID.
  if (!callerId) {
    setLoginStatus("Enter the number to call from — carriers reject a call without one.");
    return;
  }

  writeStore(SIP_CREDS_KEY, remember ? { username, password, callerId } : null);

  // A bare username is the common case; the domain comes from the registrar.
  const sipUser = username.includes("@") ? username : `${username}@registrar.vobiz.ai`;
  setLoginStatus(`Signing in as ${username}…`);

  // Tell the backend which caller ID — and so which inbound number — belongs
  // to this SIP user. Never the password: that goes only to the registrar.
  try {
    const res = await backendFetch(`${BACKEND_URL}/sip-direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, sipUser: username, callerId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `sign-in failed (${res.status})`);
  } catch (err) {
    console.error("[Vobiz] SIP direct sign-in failed:", err);
    setLoginStatus(`Could not sign in: ${err.message}`);
    return;
  }
  // Nothing is verified against an account, so dialling is enabled on the
  // strength of the registration alone — refreshDialState still requires it.
  setDialEnabled(true);
  startSipUA(sipUser, password, username);
}

/** Restore the last choice, and sign in again if the agent asked us to. */
function restoreAuthMode() {
  setAuthMode(readStore(AUTH_MODE_KEY) || "account");
  if (authMode !== "sip") return;

  const saved = readStore(SIP_CREDS_KEY);
  if (!saved || !saved.username) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("sip-username", saved.username);
  set("sip-password", saved.password);
  set("sip-caller-id", saved.callerId);
  const box = document.getElementById("sip-remember");
  if (box) box.checked = true;
  if (saved.password && saved.callerId) sipDirectConnect();
}

/**
 * The caller ID dropdown: the signed-in account's active, voice-enabled
 * numbers, as the backend listed them from Vobiz. Each shows the application
 * it is on now, which is what "Enable inbound calls" would move it off.
 */
function renderNumberOptions(numbers, selected, numberApps = {}) {
  const select = document.getElementById("vobiz-number-select");
  if (!select) return;
  select.innerHTML = "";
  (numbers || []).forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    const app = numberApps && numberApps[n];
    opt.textContent = app ? `${n} (on application ${app})` : n;
    if (n === selected) opt.selected = true;
    select.appendChild(opt);
  });
  const hasNumbers = (numbers || []).length > 0;
  select.hidden = !hasNumbers;
  const label = document.getElementById("vobiz-number-label");
  if (label) label.hidden = !hasNumbers;
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  refreshDialState();
}

function refreshDialState() {
  const btn = document.getElementById("dialbtn");
  if (!btn) return;
  const ready = accountReady && sipRegistered;
  if (ready) btn.removeAttribute("disabled");
  else btn.setAttribute("disabled", true);

  const hint = document.getElementById("dial-hint");
  if (!hint) return;
  if (ready) hint.textContent = "";
  else if (!accountReady && !sipRegistered) hint.textContent = "Log in and wait for the panel to register before calling.";
  else if (!accountReady) hint.textContent = "Log in to enable calling.";
  else hint.textContent = "Not registered — calling is disabled until the panel reconnects.";
}

function setSipRegistered(isRegistered) {
  sipRegistered = Boolean(isRegistered);
  refreshDialState();
  // Only worth asking about callers once the panel could actually take one.
  if (sipRegistered) startInboundPolling();
}

function hangUp() {
  if (!currentRTCSession) return;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] hangup failed:", err);
  }
}

/** === Incoming calls ===
 *
 * An inbound leg is NOT answered on arrival. answer() reaches for the
 * microphone, and a browser treats a microphone request that no one asked for
 * differently from one that follows a click: without a user gesture it can be
 * stalled or refused outright, particularly inside an embedded frame like this
 * one. The call then rings until the caller gives up, and the CDR shows a leg
 * billed 0s with nothing to explain it.
 *
 * Accept is that gesture. It is also simply what an agent expects — the panel
 * used to pick up by itself, with no ring, no caller shown and no way to
 * refuse.
 */
/**
 * The caller's number on a call delivered straight to this endpoint.
 *
 * The display name comes first. Vobiz will not ring a SIP user with a caller ID
 * the account does not own, so the backend's <Dial><User> presents the dialled
 * DID in the From user — the agent's own number — and carries the real caller
 * as callerName, which arrives as the display name.
 */
function callerOf(session) {
  try {
    const identity = (session && session.remote_identity) || {};
    const display = String(identity.display_name || "").trim();
    if (/^\+?\d{6,15}$/.test(display)) return e164(display);
    const user = identity.uri && identity.uri.user;
    if (user && /^\+?\d{6,15}$/.test(String(user))) return e164(user);
    return display || (user ? String(user) : "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * The backend's view of this agent's calls: when an outbound destination
 * answered, and who is ringing a SIP-direct endpoint. Null when the backend
 * does not offer it or cannot be reached — the panel then falls back to what
 * it can see for itself.
 */
async function fetchCallState() {
  if (!BACKEND_URL || !AGENT_ID) return null;
  try {
    const res = await backendFetch(`${BACKEND_URL}/call-state/${encodeURIComponent(AGENT_ID)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.now !== "number") return null;
    // Backend timestamps are its own clock. Shifted onto this one, so a skew
    // between the two never turns into talk time.
    const offset = Date.now() - data.now;
    const local = t => (typeof t === "number" ? t + offset : null);
    const out = data.outbound;
    const inbound = data.directInbound;
    return {
      outbound: out ? { to: out.to, placedAt: local(out.placedAt), answeredAt: local(out.answeredAt), endedAt: local(out.endedAt) } : null,
      directInbound: inbound ? { from: inbound.from, to: inbound.to, at: local(inbound.at) } : null,
    };
  } catch {
    return null;
  }
}

/**
 * The real caller on a SIP-direct call, when the INVITE's display name did not
 * carry it and all the From shows is the agent's own number.
 */
async function directCaller(shown) {
  const own = e164(sipDirectCallerId());
  if (shown !== "unknown" && e164(shown) !== own) return shown;
  const state = await fetchCallState();
  const inbound = state && state.directInbound;
  // Only a ring the backend saw in the last minute is this one.
  if (inbound && inbound.from && Date.now() - inbound.at < 60_000) return e164(inbound.from);
  return shown;
}

function showIncoming(from) {
  const banner = document.getElementById("incoming");
  const fromEl = document.getElementById("incoming-from");
  if (fromEl) fromEl.textContent = from;
  if (banner) banner.hidden = false;
}

/** Clear the banner and every trace of the call it belonged to. */
function endIncoming(status) {
  incomingPending = false;
  incomingOffer = null;
  // Nothing is going to use it now, and a held microphone keeps the browser's
  // recording indicator lit for a call that is over.
  releaseWarmMic();
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;
  setHangupVisible(false);
  currentRTCSession = null;
  if (status) setStatus(status);
}

/**
 * Join the conference the caller is waiting in.
 *
 * An ordinary outgoing call, the same direction the panel already uses for
 * every other call. Going out rather than being rung is the entire point:
 * Vobiz cannot deliver an INVITE into a browser (see docs/architecture.md),
 * but a browser calling out works, so inbound is built from an outgoing leg.
 *
 * The number dialled is the CALLER's, and it is never actually rung. Vobiz
 * resolves every destination through its routing service before anything
 * else, and a conference room name is not something it can resolve — the leg
 * fails as a bogus 486 Busy.
 *
 * A phone number resolves, so that is what goes on the wire. The backend
 * recognises the agent has an accepted call waiting and answers with
 * <Conference> in place of <Dial>, which is what stops the caller being rung
 * a second time.
 */
/**
 * How long to wait for ICE gathering before sending the offer anyway.
 *
 * JsSIP holds the INVITE until gathering finishes or its own timeout expires,
 * which on a machine with many network interfaces can be tens of seconds — with
 * an inbound caller listening to hold music throughout. One server-reflexive
 * candidate is all the media server needs.
 */
const ICE_CAP_MS = 2500;

/**
 * Send the offer as soon as ICE has something usable instead of waiting for
 * gathering to finish. JsSIP hands every candidate a `ready` callback for
 * exactly this; calling it settles the SDP and releases the INVITE.
 *
 * Worth more than the latency it saves: candidates carry STUN bindings that
 * age, so an offer held back for tens of seconds can reach the media server
 * describing a path that has already lapsed. Signalling still completes and the
 * call still bills, but no audio flows in either direction.
 */
function capIceGathering(session, label) {
  const started = Date.now();
  let settled = false;
  let lastReady = null;

  const go = why => {
    if (settled || !lastReady) return;
    settled = true;
    console.log(`[Vobiz] ${label}: sending after ${Date.now() - started}ms (${why})`);
    try { lastReady(); } catch { /* gathering already finished on its own */ }
  };

  session.on("icecandidate", ({ candidate, ready }) => {
    lastReady = ready;
    const c = (candidate && candidate.candidate) || "";
    // A reflexive candidate means STUN answered, which is the one thing the
    // media server needs that a host candidate cannot give it.
    if ((candidate && candidate.type === "srflx") || c.includes(" typ srflx")) {
      go("have a reflexive candidate");
    }
  });
  setTimeout(() => go("gathering took too long"), ICE_CAP_MS);
}

function joinRoom(room, from, callUuid, record = Promise.resolve(null)) {
  const numEl = document.getElementById("callnum");
  const caller = from || "";
  const target = String(caller).replace(/[^\d+]/g, "");

  if (numEl) {
    numEl.textContent = `Connecting to ${caller || "caller"}…`;
    numEl.hidden = false;
  }

  // Without a number there is nothing Vobiz will route, and dialling the room
  // name instead is the failure this function exists to avoid.
  if (!target) {
    if (numEl) numEl.textContent = "Could not connect — the caller's number is unknown";
    setStatus("Ready");
    return;
  }

  // Hand over the microphone taken while the banner rang, if there is one, so
  // call() does not stop to ask for one. Ownership passes to JsSIP here — it
  // stops the tracks when the call ends — so the reference is dropped rather
  // than released.
  const warmed = warmMicStream;
  warmMicStream = null;

  try {
    const session = vobizUA.call(`sip:${target}@registrar.vobiz.ai`, {
      // The Record choice applies to an inbound call too. Recording starts when
      // this leg joins, so the caller's time on hold is not in the file.
      extraHeaders: callHeaders(),
      ...(warmed ? { mediaStream: warmed } : { mediaConstraints: { audio: true, video: false } }),
      // Same reason as every other leg: without STUN the offer carries only
      // host candidates and the call is torn down before any audio flows.
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    capIceGathering(session, "join");
    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    // Stamped on confirmed rather than at call time: the gap before that is
    // ringing, and ringing is not a conversation.
    let startedAt = null;
    session.on("confirmed", () => {
      startedAt = Date.now();
      if (numEl) numEl.textContent = `On a call with ${caller}`;
      setStatus("On a call");
    });
    session.on("failed", e => {
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Could not connect — ${cause}`;
      currentRTCSession = null;
      setHangupVisible(false);
      setStatus("Ready");
    });
    session.on("ended", () => {
      if (numEl) {
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
      }
      currentRTCSession = null;
      setHangupVisible(false);
      setStatus("Ready");
      // Hanging up here ends this browser leg and nothing else — the caller is
      // in a conference room they hold on their own, so without this they stay
      // connected, in silence, for as long as the room's time limit allows.
      // Harmless in the other direction too: if the caller hung up first their
      // leg is already gone and the backend treats that as done.
      if (callUuid) {
        backendFetch(`${BACKEND_URL}/inbound-hangup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: AGENT_ID, callUuid }),
        }).catch(err => console.warn("[Vobiz] could not release the caller's leg:", err));
      }
      // A call that never connected is still worth filing, with a duration of
      // zero rather than however long it rang. The record was found — and
      // popped — when the call started ringing.
      const durationSec = startedAt ? (Date.now() - startedAt) / 1000 : 0;
      record.then(match => logCallToCrm({ number: caller, inbound: true, durationSec, record: match }));
    });
  } catch (err) {
    console.error("[Vobiz] could not join the room:", err);
    if (numEl) numEl.textContent = `Could not connect — ${err.message}`;
    setStatus("Ready");
  }
}

async function acceptCall() {
  // Two shapes of incoming call arrive here. `incomingOffer` is the conference
  // bridge, which is how inbound works. The JsSIP branch below handles a call
  // delivered straight to this endpoint, for a backend that routes one here.
  if (incomingOffer) {
    const offer = incomingOffer;
    incomingOffer = null;
    incomingPending = false;
    stopRingtone();
    const banner = document.getElementById("incoming");
    if (banner) banner.hidden = true;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("no microphone available in this frame");
      }
      const res = await backendFetch(`${BACKEND_URL}/inbound-accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_ID }),
      });
      const data = await res.json();
      // The caller may have hung up in the second it took to click.
      if (!data.ok) throw new Error(data.reason || "the call is no longer ringing");
      joinRoom(data.room, data.from || offer.from, data.callUuid || offer.callUuid, offer.record);
    } catch (err) {
      console.error("[Vobiz] accept failed:", err);
      endIncoming(`Could not accept — ${err.message}`);
    }
    return;
  }

  if (!currentRTCSession) return;
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("navigator.mediaDevices is unavailable — this frame is not a secure context");
    }
    attachRemoteAudio(currentRTCSession);
    // pcConfig matters here exactly as much as it does on an outbound call:
    // without STUN the answer carries host-only candidates and the leg is torn
    // down without connecting, leaving a leg billed 0s and no explanation.
    currentRTCSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    setHangupVisible(true);
    setStatus("On a call");
  } catch (err) {
    console.error("[Vobiz] could not answer the incoming leg:", err);
    setStatus(`Could not answer — ${err.name === "NotAllowedError"
      ? "microphone permission was refused for this frame"
      : err.message}`);
    try { currentRTCSession.terminate(); } catch { /* already gone */ }
    endIncoming();
  }
}

async function declineCall() {
  if (incomingOffer) {
    incomingOffer = null;
    incomingPending = false;
    // Declining ends the room, which drops the caller out of <Conference> and
    // on to the voicemail that follows it — they get to leave a message rather
    // than simply being cut off.
    try {
      await backendFetch(`${BACKEND_URL}/inbound-decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_ID }),
      });
    } catch (err) {
      console.warn("[Vobiz] decline failed:", err);
    }
    endIncoming("Ready");
    return;
  }

  if (!currentRTCSession) return;
  incomingPending = false;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] decline failed:", err);
  }
  endIncoming();
}

/**
 * Ask the backend whether a caller is waiting.
 *
 * Polling rather than a pushed SIP INVITE because the INVITE is exactly what
 * cannot be delivered. Runs only while registered and only while no call is in
 * progress, so an established call is never interrupted by a stale offer.
 */
async function pollInbound() {
  if (!BACKEND_URL || !AGENT_ID) return;
  if (!sipRegistered || currentRTCSession || incomingPending) return;
  try {
    const res = await backendFetch(`${BACKEND_URL}/inbound-pending/${encodeURIComponent(AGENT_ID)}`);
    const data = await res.json();
    if (!data || !data.pending) return;
    incomingOffer = {
      room: data.room,
      from: data.from,
      callUuid: data.callUuid,
      // Looked up while the panel rings, so the caller's record is already on
      // screen by the time the agent decides whether to accept.
      record: findRecord(data.from, true),
    };
    incomingPending = true;
    showIncoming(data.from || "unknown");
    startRingtone();
    // Not awaited: the banner and ringtone must not wait on a permission prompt.
    warmMic();
  } catch {
    // The tunnel drops, the laptop sleeps, the backend restarts. None of that
    // is worth a message in the panel — the next tick simply tries again.
  }
}

function startInboundPolling() {
  if (inboundPollTimer) return;
  // Every second, not every two. The caller is listening to hold music for the
  // whole of this, and every part of that delay this panel owns is worth
  // removing.
  inboundPollTimer = setInterval(pollInbound, 1000);
}

/**
 * Take the microphone while the banner is still ringing.
 *
 * JsSIP asks for the microphone inside call(), and only starts gathering ICE
 * once it has one — so that cost lands after the agent clicks, while the caller
 * waits. Acquiring it up front moves it into the ringing window, and the stream
 * is handed to call() directly so it is not requested twice.
 *
 * Best-effort: if it fails, joinRoom falls back to asking for the microphone
 * the normal way and the call still connects, just a little slower.
 */
async function warmMic() {
  if (warmMicStream) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    warmMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.warn("[Vobiz] could not pre-acquire the microphone:", err && err.name);
    warmMicStream = null;
  }
}

/** Let the microphone go when it is no longer needed for a pending offer. */
function releaseWarmMic() {
  if (!warmMicStream) return;
  try {
    warmMicStream.getTracks().forEach(t => t.stop());
  } catch { /* already stopped */ }
  warmMicStream = null;
}

/** A ringtone, synthesised — nothing to ship and nothing to fail to load. */
let ringCtx = null;
let ringTimer = null;

function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.95);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) {
    // A silent panel is worse than no ringtone, but not worth failing the call
    // over — the banner is still on screen either way.
    console.warn("[Vobiz] could not start the ringtone:", err);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) {
    try { ringCtx.close(); } catch { /* already closed */ }
    ringCtx = null;
  }
}

function setHangupVisible(visible) {
  const btn = document.getElementById("hangupbtn");
  if (btn) btn.hidden = !visible;
}

async function restoreVobizSession() {
  try {
    const res = await backendFetch(`${BACKEND_URL}/session/${encodeURIComponent(AGENT_ID)}`);
    const session = await res.json();
    if (session.loggedIn && session.mode !== "sip") {
      renderNumberOptions(session.numbers, session.from, session.numberApps);
      setLoginStatus(`Logged in as ${session.authId} — calling from ${session.from}`);
      setDialEnabled(true);
    } else {
      setDialEnabled(false);
    }
  } catch (err) {
    console.warn("[Vobiz] Could not check login session:", err);
  }
}

async function vobizLogin() {
  const authId = document.getElementById("vobiz-auth-id").value.trim();
  const authToken = document.getElementById("vobiz-auth-token").value.trim();
  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.");
    return;
  }
  setLoginStatus("Logging in…");
  try {
    const res = await backendFetch(`${BACKEND_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, authId, authToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `login failed (${res.status})`);
    renderNumberOptions(data.numbers, data.selected, data.numberApps);
    setLoginStatus(
      (data.numbers || []).length
        ? `Logged in as ${authId} — calling from ${data.selected}`
        : `Logged in as ${authId} — this account has no phone numbers yet`,
    );
    setDialEnabled(Boolean(data.selected));

    // The SIP identity is the thing account credentials buy: the backend
    // provisions an endpoint from the account during this call, so it does not exist until now. Re-running the identity
    // fetch registers with it. Without this the account login succeeds while
    // the panel stays OFFLINE, still showing the pre-sign-in failure.
    await initVobizSip();
  } catch (err) {
    console.error("[Vobiz] Login failed:", err);
    setLoginStatus(`Login failed: ${err.message}`);
    setDialEnabled(false);
  }
}

async function vobizSelectNumber() {
  const number = document.getElementById("vobiz-number-select").value;
  try {
    const res = await backendFetch(`${BACKEND_URL}/select-number`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `could not switch numbers (${res.status})`);
    setLoginStatus(`Calling from ${data.selected}`);
  } catch (err) {
    console.error("[Vobiz] Could not switch numbers:", err);
    setLoginStatus(`Could not switch numbers: ${err.message}`);
  }
}

/** === Inbound calling setup (one-time, manual — real account changes) ===
 * Creates a Vobiz Application pointed at this backend's /inbound-answer and
 * attaches the currently-selected number to it. Only runs when the button
 * is clicked — never automatically — since this changes real Vobiz account
 * routing, not just local UI state.
 */
async function setupInboundCalling() {
  const statusEl = document.getElementById("inbound-setup-status");
  const btn = document.getElementById("setup-inbound-btn");
  statusEl.textContent = "Setting up inbound routing…";
  statusEl.classList.remove("is-ok", "is-error");
  btn.setAttribute("disabled", true);
  try {
    const res = await backendFetch(`${BACKEND_URL}/setup-inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Declaring the platform matters: this panel is browser-only, so the
      // backend must not also ring the agent's mobile on an inbound call.
      body: JSON.stringify({ agentId: AGENT_ID, platform: "salesforce" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `setup failed (${res.status})`);
    const moved = data.previousApplicationId && data.previousApplicationId !== data.applicationId
      ? ` It was moved off application ${data.previousApplicationId}.` : "";
    statusEl.textContent = `Inbound calls to ${data.number} now ring this panel.${moved}`;
    statusEl.classList.add("is-ok");
  } catch (err) {
    console.error("[Vobiz] Inbound setup failed:", err);
    statusEl.textContent = `Setup failed: ${err.message}`;
    statusEl.classList.add("is-error");
  } finally {
    btn.removeAttribute("disabled");
  }
}

/**
 * === Recording ===
 *
 * Whether a call is recorded is decided per call, by the agent, and travels on
 * the call itself: Vobiz strips headers beginning `X-VH-` off the INVITE and
 * hands them to the answer webhook as ordinary fields, so a ticked box here
 * becomes `<Record>` in the XML the backend returns. Unticked sends no header,
 * the backend emits no `<Record>`, and nothing is recorded or billed for.
 *
 * The same header rides on every call this panel places — a dialled number, or
 * the leg that joins an inbound caller's room — so both directions obey the
 * box without the backend having to remember anything between requests.
 *
 * There is no recordings list here any more. Recordings live in the Vobiz
 * Console, which already lists them; mirroring that meant streaming call audio
 * back out through the calling backend, so anyone who could reach the backend
 * could pull recordings out of it.
 */
function wantsRecording() {
  const box = document.getElementById("record-call");
  return Boolean(box && box.checked);
}

/**
 * Extra SIP headers for a call, as JsSIP wants them: whole header lines.
 *
 * Vobiz applies its own rules to these and silently drops anything that fails
 * them, so keep values inside [A-Za-z0-9_+()%.-] with no spaces. `true` is
 * safely inside that set.
 */
function callHeaders() {
  const headers = [];
  if (wantsRecording()) headers.push("X-VH-Record: true");
  // Signed in as an endpoint, there is no account session for the backend to
  // read a caller ID out of, so it travels on the call like everything else
  // the agent chose. In account mode the backend already knows it.
  if (authMode === "sip") {
    const callerId = sipDirectCallerId().replace(/[^\d+]/g, "");
    if (callerId) headers.push(`X-VH-Caller-ID: ${callerId}`);
  }
  return headers;
}

/**
 * Status is two things, not one.
 *
 * The header carries a short STATE ("Ready", "Offline", "On a call") — that is
 * what a badge is for. The full sentence, which can run to seventy characters,
 * goes in a message row beneath it where there is room to read it.
 *
 * Cramming a sentence into a nowrap pill is what made the header overflow.
 */
function statusState(text) {
  if (/^ready/i.test(text)) return { label: "Ready", tone: "ok" };
  if (/^on a call/i.test(text)) return { label: "On a call", tone: "busy" };
  if (/^call ringing/i.test(text)) return { label: "Ringing", tone: "busy" };
  if (/^connecting/i.test(text)) return { label: "Connecting", tone: "pending" };
  if (/reconnecting/i.test(text)) return { label: "Reconnecting", tone: "pending" };
  if (/^not configured|must start with|cannot reach|could not load|registration failed/i.test(text)) {
    return { label: "Offline", tone: "error" };
  }
  return { label: "Offline", tone: "error" };
}

function setStatus(text) {
  const el = document.getElementById("status");
  const msg = document.getElementById("status-message");
  const { label, tone } = statusState(text);

  if (el) {
    el.textContent = label;
    el.className = `status-badge is-${tone}`;
  }

  if (msg) {
    // Only show the sentence when it says more than the badge already does.
    const redundant = label.toLowerCase() === text.trim().toLowerCase();
    msg.textContent = redundant ? "" : text;
    msg.hidden = redundant;
    msg.className = `status-message is-${tone}`;
  }
}

// For an INCOMING session JsSIP has not built the RTCPeerConnection yet —
// session.connection is still null until the call is answered. Touching it
// here throws, and because that throw happens inside the newRTCSession
// handler it aborts before .answer() ever runs: the browser silently never
// picks up, Vobiz rings the endpoint until it times out, and the far end is
// never dialed. Bind via the "peerconnection" event instead, and only fall
// back to session.connection when one already exists.
function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[Vobiz] audio autoplay blocked:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

/** A placeholder a backend may return before sign-in, so it is never registered with. */
const PLACEHOLDER_SIP_PASSWORD = "PUT-THE-ENDPOINT-PASSWORD-HERE";

async function initVobizSip() {
  let agent;
  try {
    const res = await backendFetch(`${BACKEND_URL}/agent/${encodeURIComponent(AGENT_ID)}`);
    if (!res.ok) {
      setStatus(`Could not load the identity "${AGENT_ID}" — check this app's settings.`);
      setSipRegistered(false);
      return;
    }
    agent = await res.json();
  } catch (err) {
    // The usual cause is the backend being unreachable. Without this catch the
    // rejection is unhandled and the panel sits on "Connecting…" forever.
    console.error("[Vobiz] Could not reach the calling backend:", err);
    setStatus("Cannot reach the calling backend — check the Backend URL in this app's settings.");
    setSipRegistered(false);
    return;
  }

  // Before account sign-in the backend has no identity to hand over. A
  // placeholder password reaches the registrar as an ordinary wrong password — so registering here puts "Registration failed:
  // Authentication Error" on the panel, blaming an Auth ID and Auth Token the
  // agent has not typed yet. vobizLogin() calls this again once sign-in has let
  // the backend provision a real endpoint from the account.
  if (!agent.provisioned && (!agent.sipPassword || agent.sipPassword === PLACEHOLDER_SIP_PASSWORD)) {
    setStatus("Sign in below to bring your phone line online.");
    setSipRegistered(false);
    return;
  }

  startSipUA(agent.sipUser, agent.sipPassword, agent.displayName);
}

/**
 * Bring up the SIP stack for one identity.
 *
 * Shared by both ways in: the account sign-in above, which asks the backend
 * which identity this installation is, and SIP-direct sign-in, where the agent
 * types the endpoint's own credentials and the backend is never involved.
 */
function startSipUA(sipUser, sipPassword, displayName) {
  setStatus(`Connecting as ${displayName}…`);

  // Re-signing in replaces the previous registration rather than stacking a
  // second one on the same identity; two live registrations evict each other.
  //
  // Its listeners come off FIRST. stop() unregisters and closes the socket
  // asynchronously, so the outgoing UA fires `unregistered` and `disconnected`
  // a moment later — after this function has already started the replacement.
  // Left attached, those handlers overwrite the new UA's status with
  // "Disconnected from the registrar", describing a UA that is gone while the
  // live one is connecting perfectly well.
  if (vobizUA) {
    const previous = vobizUA;
    vobizUA = null;
    try { previous.removeAllListeners(); } catch { /* not an emitter after all */ }
    try { previous.stop(); } catch { /* already down */ }
  }

  const vobizSocket = new JsSIP.WebSocketInterface(REGISTRAR_URL);
  const ua = new JsSIP.UA({
    sockets: [vobizSocket],
    uri: `sip:${sipUser}`,
    password: sipPassword,
    register: true,
    // No space in the User-Agent, deliberately. Vobiz embeds the registration's
    // User-Agent in a SIP URI when it routes a call to this endpoint, and a
    // space (JsSIP's default is "JsSIP 3.10.1") makes that URI unparseable, so
    // the call is dropped before it reaches the browser. Keep it one token.
    user_agent: "VobizSalesforceCalling/1.1.0",
    // Vobiz's media server rejects JsSIP's default session-timer proposal with
    // "422 Session Interval Too Small", which JsSIP surfaces only as the opaque
    // cause "SIP Failure Code", with no CDR because the call is never created.
    // Vobiz's own WebRTC SDK disables session timers the same way.
    session_timers: false,
  });
  vobizUA = ua;

  // Belt and braces alongside removeAllListeners above: a handler only speaks
  // for the UA it was attached to. Anything arriving from a superseded one —
  // a late event, a retry already in flight — is about a connection nobody is
  // using any more, and must not be reported as the state of this panel.
  const isCurrent = () => vobizUA === ua;

  // Signing in with endpoint credentials puts the outcome next to the form the
  // agent just used. Without this the sign-in line sits on "Signing in as …"
  // for as long as the panel is open while the real answer — most often a
  // rejected password — is reported somewhere else entirely, and a wrong
  // password reads as a hang.
  const reportSignIn = text => { if (authMode === "sip") setLoginStatus(text); };

  ua.on("registered", () => {
    if (!isCurrent()) return;
    setStatus(`Ready — registered as ${displayName}`);
    reportSignIn(`Signed in as ${displayName}.`);
    setSipRegistered(true);
  });
  ua.on("registrationFailed", e => {
    if (!isCurrent()) return;
    const cause = (e && e.cause) || "unknown";
    setStatus(`Registration failed: ${cause}`);
    // JsSIP reports a rejected password as an authentication cause, which on
    // its own does not tell an agent what to do about it.
    reportSignIn(/auth/i.test(cause)
      ? `Vobiz rejected these credentials (${cause}). Check the username, and set a password you know with Change on that endpoint in Console.`
      : `Could not sign in: ${cause}`);
    setSipRegistered(false);
  });
  // Without these two, a dropped transport leaves the panel showing "Ready"
  // while the endpoint is uncallable.
  ua.on("unregistered", () => {
    if (!isCurrent()) return;
    setStatus("Not registered — reconnecting…");
    reportSignIn("Signed out — reconnecting…");
    setSipRegistered(false);
  });
  ua.on("disconnected", () => {
    if (!isCurrent()) return;
    setStatus("Disconnected from the registrar — reconnecting…");
    reportSignIn("Disconnected from the registrar — reconnecting…");
    setSipRegistered(false);
  });

  // A call delivered straight to this endpoint: a SIP-direct sign-in's number
  // being rung by <Dial><User>. Account sign-ins are never rung this way —
  // their inbound calls arrive through the conference poll above.
  ua.on("newRTCSession", data => {
    if (!isCurrent()) return;
    if (data.originator !== "remote") return;
    receiveDirectCall(data.session, displayName);
  });

  ua.start();

  // Surface a dead microphone path at startup rather than mid-call.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[Vobiz] navigator.mediaDevices is unavailable in this frame — inbound audio cannot work.");
    setStatus("No microphone access in this frame — calls will ring but cannot connect.");
  }
}

/**
 * Ring for a call delivered straight to this endpoint, pop the caller's record
 * while it rings, and file a Task when it ends — the same as any other call.
 *
 * Talk time runs from `confirmed`, which for this leg is the agent answering:
 * the caller is already on the line by then. A call nobody answered is filed
 * as missed, with no talk time.
 */
function receiveDirectCall(session, displayName) {
  currentRTCSession = session;
  let caller = callerOf(session);
  let startedAt = null;
  let declined = false;
  let filed = false;

  setStatus(`Incoming call from ${caller}`);
  incomingPending = true;
  showIncoming(caller);
  startRingtone();

  // Resolved first, then looked up, so the record pops while the panel rings.
  const record = (authMode === "sip" ? directCaller(caller) : Promise.resolve(caller)).then(number => {
    if (number !== caller) {
      caller = number;
      if (incomingPending && currentRTCSession === session) {
        showIncoming(caller);
        setStatus(`Incoming call from ${caller}`);
      }
    }
    return findRecord(caller, true);
  });

  session.on("confirmed", () => {
    startedAt = Date.now();
    setStatus("On a call");
  });
  // Declining is the agent's own choice; anything else that ends an unanswered
  // ring is a missed call.
  const terminate = session.terminate && session.terminate.bind(session);
  if (terminate) session.terminate = (...args) => { if (!startedAt) declined = true; return terminate(...args); };

  const finish = () => {
    // The caller can give up, or Vobiz can time the leg out, while the banner
    // is still on screen. Clear it either way rather than leaving an Accept
    // button that answers a call which no longer exists.
    endIncoming(`Ready — registered as ${displayName}`);
    if (filed) return;
    filed = true;
    const durationSec = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    const outcome = startedAt ? null : declined ? "Declined" : "Missed";
    record.then(match => logCallToCrm({ number: caller, inbound: true, durationSec, record: match, outcome }));
  };
  session.on("ended", finish);
  session.on("failed", finish);
}

/* ------------------------------------------------------------------ *
 * Salesforce: screen pop and call logging, over Open CTI
 *
 * The record is looked up once per call, as early as possible — on ring for
 * an inbound call, on dial for an outbound one — so the agent lands on it
 * while the call is still connecting. The same match is then used to relate
 * the Task written when the call ends, without popping anything a second time.
 * ------------------------------------------------------------------ */

/** Numbers are searched and logged in E.164 form. */
function e164(number) {
  const digits = String(number || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/** Object types a Task's WhoId may point at. Any other match goes in WhatId. */
const WHO_TYPES = new Set(["Contact", "Lead"]);

/**
 * The Salesforce record this number belongs to, or null when nobody matches.
 *
 * searchAndScreenPop does the lookup and the screen pop in one call, which is
 * how Open CTI expects a softphone to behave. One match pops automatically;
 * several leave Salesforce's own search results on screen for the agent to
 * choose from, and the panel does not guess on their behalf. A miss is not an
 * error — plenty of calls are to people who are not in the CRM.
 */
async function findRecord(number, inbound) {
  const phone = e164(number);
  if (!phone) return null;
  try {
    const found = await openCti("searchAndScreenPop", {
      searchParams: phone,
      callType: inbound ? sforce.opencti.CALL_TYPE.INBOUND : sforce.opencti.CALL_TYPE.OUTBOUND,
      deferred: false,
    });
    // Keyed by record id, with the object type in each entry's RecordType.
    const ids = Object.keys(found || {}).filter(key => key !== "SCREEN_POP_DATA");
    if (ids.length !== 1) return null;
    const entry = found[ids[0]] || {};
    return { id: entry.Id || ids[0], type: entry.RecordType || "" };
  } catch (err) {
    console.warn("[Vobiz] record lookup failed:", err && err.message);
    return null;
  }
}

/**
 * Write a finished call to Salesforce as a completed Task.
 *
 * Best effort by design: a CRM that is slow, unreachable or simply has no
 * matching record must not surface as a calling error. The call already
 * happened; failing to file it is a logging problem, not a telephony one.
 *
 * A Task is what Open CTI's saveLog writes, and what Salesforce's own call
 * logging produces — so these appear in Activity History next to every other
 * logged call rather than somewhere only this app knows about.
 *
 * `record` is the match found when the call started, so nothing is looked up
 * or popped again here.
 */
async function logCallToCrm({ number, inbound, durationSec, record, outcome = null }) {
  // `outcome` names a call that never became a conversation — "No answer",
  // "Missed", "Declined" — and goes in the subject, where an agent scanning
  // Activity History sees it, and in CallDisposition, where reports can.
  const subject = `Vobiz call ${inbound ? "from" : "to"} ${e164(number)}${outcome ? ` (${outcome.toLowerCase()})` : ""}`;
  // A Contact or Lead is the person on the call (WhoId); an Account, Case or
  // Opportunity is what the call was about (WhatId). Putting an Account id in
  // WhoId makes Salesforce reject the whole Task.
  const related = record && record.id
    ? (WHO_TYPES.has(record.type) ? { WhoId: record.id } : { WhatId: record.id })
    : {};

  try {
    await openCti("saveLog", {
      value: {
        entityApiName: "Task",
        Subject: subject,
        CallType: inbound ? "Inbound" : "Outbound",
        CallDurationInSeconds: outcome ? 0 : Math.max(0, Math.round(durationSec || 0)),
        ...(outcome ? { CallDisposition: outcome } : {}),
        Description: subject,
        Status: "Completed",
        ActivityDate: new Date().toISOString().slice(0, 10),
        // Left unset when nothing matched, which files the call without a
        // related record rather than dropping it.
        ...related,
      },
    });
    console.info("[Vobiz] logged the call" + (record ? ` against ${record.id}` : " with no matching record"));
    return record ? record.id : null;
  } catch (err) {
    console.warn("[Vobiz] could not write the call log:", err && err.message);
    return null;
  }
}

/**
 * Ask the host to do something, and treat a refusal as information rather than
 * a failure: an id this product does not recognise rejects, and that is the
 * normal way to discover which of two products the panel is running in.
 */
function tryInterface(payload) {
  try {
    const result = client.interface.trigger("show", payload);
    if (result && typeof result.catch === "function") {
      result.catch(reason => console.debug("[Vobiz] host declined show", payload, reason));
    }
    return true;
  } catch (err) {
    console.debug("[Vobiz] host declined show", payload, err && err.message);
    return false;
  }
}

function onTriggerDialer(event) {
  showPanel();
  // opencti-host.js delivers Salesforce's click as { phoneNumber, recordId,
  // objectType }. The record is the one the agent clicked on, so it is used as
  // the call's record directly — there is nothing to search for or pop.
  const data = (event && event.data) || {};
  const number = data.phoneNumber || null;
  const clicked = data.recordId ? { id: data.recordId, type: data.objectType || "" } : null;
  placeCall(number, clicked);
}

/** Open the utility panel, so a click-to-dial never dials invisibly. */
function showPanel() {
  tryInterface({ id: "softphone" });
}

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  placeCall(number);
}

/** How often the panel asks whether the destination has answered. */
const CALL_STATE_POLL_MS = 1000;
/** Slack for a backend that records the call a moment before the panel stamps it. */
const PLACED_SLACK_MS = 5000;

/**
 * Talk time for an outbound call: from the destination answering, as the
 * backend reports it, to the call ending.
 *
 * Polled once a second while the call is up, and once more as it ends so a
 * short call is not missed between polls. Falls back to the panel's own
 * connect time only when the backend offers no call state at all (a custom
 * backend without /call-state) — never because the destination is slow.
 */
function outboundTalkClock(number, placedAt) {
  let answeredAt = null;
  let backendSpoke = false;
  let connectedAt = null;
  let timer = null;
  const listeners = [];

  const thisCall = out => out && out.placedAt !== null && out.placedAt >= placedAt - PLACED_SLACK_MS
    && (!out.to || e164(out.to) === e164(number));

  async function check() {
    const state = await fetchCallState();
    if (!state) return;
    backendSpoke = true;
    const out = state.outbound;
    if (thisCall(out) && out.answeredAt && !answeredAt) {
      answeredAt = out.answeredAt;
      listeners.forEach(fn => fn());
    }
  }

  return {
    legConnected() {
      connectedAt = Date.now();
      if (!timer) timer = setInterval(check, CALL_STATE_POLL_MS);
      check();
    },
    onAnswered(fn) { listeners.push(fn); },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async finish() {
      this.stop();
      const endedAt = Date.now();
      if (!answeredAt) await check();
      if (answeredAt) return { durationSec: Math.max(0, (endedAt - answeredAt) / 1000), outcome: null };
      if (backendSpoke || !connectedAt) return { durationSec: 0, outcome: "No answer" };
      return { durationSec: (endedAt - connectedAt) / 1000, outcome: null };
    },
  };
}

/**
 * Place an outbound call with this browser as the A leg.
 *
 * The browser sends the INVITE itself. Vobiz then fetches the endpoint
 * application's answer URL, and the backend puts this leg in a conference room
 * and dials the destination into it over the REST API — see
 * docs/backend-contract.md → /answer.
 *
 * `clicked` is the Salesforce record a click-to-dial came from, when there is
 * one. Without it, the number is looked up (and the match popped) as the call
 * starts.
 */
function placeCall(number, clicked = null) {
  if (!number) return;

  const numEl = document.getElementById("callnum");
  if (numEl) {
    numEl.textContent = `Calling ${number}…`;
    numEl.hidden = false;
  }

  if (!vobizUA || !sipRegistered) {
    const message = "Not registered yet — wait for the badge to go green.";
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    return;
  }

  // Vobiz routes a bare E.164 destination; the registrar is the SIP domain.
  const target = `sip:${String(number).replace(/[^\d+]/g, "")}@registrar.vobiz.ai`;
  const placedAt = Date.now();

  try {
    const session = vobizUA.call(target, {
      // Carries the Record choice to the backend — see callHeaders().
      extraHeaders: callHeaders(),
      mediaConstraints: { audio: true, video: false },
      // Without a STUN server the offer carries only host candidates, so Vobiz
      // sees a private address and logs "PrivateIP … Detected in SDP"; the
      // early-media answer that comes back is then rejected by the browser as
      // an incompatible SDP and the call is cancelled inside a few hundred ms.
      // These are the values Vobiz's own SDK uses.
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    capIceGathering(session, "call");
    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    // Started now, not when the call ends, so the record is on screen while the
    // destination is still ringing.
    const record = clicked ? Promise.resolve(clicked) : findRecord(number, false);

    // This leg is confirmed the moment it reaches the waiting room, while the
    // destination is still ringing — so `confirmed` is NOT when talking starts.
    // The backend sees the destination answer, and the panel asks it.
    const talk = outboundTalkClock(number, placedAt);
    session.on("progress", () => { if (numEl) numEl.textContent = `Ringing ${number}…`; });
    session.on("confirmed", () => {
      talk.legConnected();
      if (numEl) numEl.textContent = `Ringing ${number}…`;
      setStatus("On a call");
    });
    talk.onAnswered(() => { if (numEl) numEl.textContent = `On a call with ${number}`; });
    session.on("failed", e => {
      talk.stop();
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Call failed — ${cause}`;
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
    });
    session.on("ended", async () => {
      if (numEl) {
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
      }
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
      const { durationSec, outcome } = await talk.finish();
      record.then(match => logCallToCrm({ number, inbound: false, durationSec, record: match, outcome }));
    });
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    const message = err && err.name === "NotAllowedError"
      ? "Microphone permission was refused for this frame"
      : `Could not start the call — ${err.message}`;
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
  }
}

