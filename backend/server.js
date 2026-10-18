#!/usr/bin/env node
/**
 * Vobiz Calling for Salesforce — reference calling backend.
 *
 * A complete, dependency-free implementation of docs/backend-contract.md, so
 * the panel in app/ can make and take real calls without writing a backend
 * first. It also serves the panel itself, at /salesforce/softphone.html, which
 * is the recommended setup: one origin, no CORS, and a session cookie the panel
 * sends without any code of its own.
 *
 * It is a REFERENCE: one process, state in memory, sessions lost on restart.
 * That is the right shape for evaluating the integration, recording a demo or
 * running a small team. Read "Running it in production" in backend/README.md
 * before putting real traffic through it.
 *
 *   node backend/server.js            (Node 20.12 or later; no npm install)
 *
 * Configuration is by environment variable, or backend/.env — see
 * backend/.env.example.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

try { process.loadEnvFile(path.join(__dirname, ".env")); } catch { /* no .env: use the real environment */ }

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

function config() {
  const env = process.env;
  return {
    port: Number(env.PORT || 8080),
    // The public HTTPS address Vobiz reaches this server at — a tunnel while
    // developing. Every webhook URL handed to Vobiz is built from it.
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    apiBase: (env.VOBIZ_API_BASE || "https://api.vobiz.ai").replace(/\/+$/, ""),
    // Who may frame the panel. Salesforce Lightning serves the utility bar
    // from *.lightning.force.com; the rest cover Setup and classic hosts.
    frameAncestors: env.SALESFORCE_FRAME_ANCESTORS
      || "https://*.lightning.force.com https://*.my.salesforce.com https://*.force.com",
    // Optional. Only used for agents who sign in on the SIP direct tab, which
    // creates no account session — see the README.
    accountAuthId: env.VOBIZ_AUTH_ID || "",
    accountAuthToken: env.VOBIZ_AUTH_TOKEN || "",
    sipDirectUsers: new Set((env.SIP_DIRECT_USERNAMES || "").split(",").map(s => s.trim()).filter(Boolean)),
    requireSignature: env.REQUIRE_VOBIZ_SIGNATURE === "true",
    inboundRingSeconds: Number(env.INBOUND_RING_SECONDS || 45),
    outboundRingSeconds: Number(env.OUTBOUND_RING_SECONDS || 45),
    sessionHours: Number(env.SESSION_HOURS || 12),
  };
}

const APP_DIR = path.join(__dirname, "..", "app");
/** Served by name rather than joined from the request path — no traversal. */
const PANEL_FILES = {
  "softphone.html": "text/html; charset=utf-8",
  "softphone.js": "application/javascript; charset=utf-8",
  "opencti-host.js": "application/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "lib/jssip.min.js": "application/javascript; charset=utf-8",
};

const COOKIE = "vobiz_sf_session";
const AGENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** How long after the agent last polled they still count as present. */
const PRESENCE_MS = 5000;
/** How long after Accept a browser leg still counts as joining the caller. */
const JOIN_WINDOW_MS = 90_000;

/* ------------------------------------------------------------------ *
 * State — in memory, one process
 * ------------------------------------------------------------------ */

function freshState() {
  return {
    /** sid -> { sid, agentId, authId, authToken, numbers, from, sip, expires } */
    sessions: new Map(),
    /** agentId -> sid of their current session */
    sessionByAgent: new Map(),
    /** agentId -> ms of the panel's last /inbound-pending poll */
    lastPoll: new Map(),
    /** agentId -> { room, from, to, callUuid, state: "ringing"|"accepted", timer } */
    pending: new Map(),
    /** agentId -> { room, from, callUuid, at, callerGone } */
    joinExpected: new Map(),
    /** inbound caller CallUUID -> agentId, so /inbound-hangup can only release that agent's caller */
    inboundCalls: new Map(),
    /** outbound room -> { creds, agentId, legs: Set, answered, closed, timer } */
    outboundRooms: new Map(),
  };
}
let state = freshState();

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const log = (...a) => console.log("[backend]", ...a);
const warn = (...a) => console.warn("[backend]", ...a);

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sendXml(res, xml) {
  // Vobiz treats text/html or text/plain as a parse error.
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(xml.startsWith("<?xml") ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
}

const EMPTY = "<Response></Response>";
const HANGUP = "<Response><Hangup/></Response>";

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Vobiz's webhook fields: a form body on POST, the query string on GET. */
async function webhookFields(req, url) {
  if (req.method === "GET") return Object.fromEntries(url.searchParams);
  const raw = await readBody(req);
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/json")) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** Case-insensitive read of a field. Vobiz promises no casing for X-VH-* headers. */
function field(body, name) {
  const wanted = name.toLowerCase();
  const key = Object.keys(body || {}).find(k => k.toLowerCase() === wanted);
  return key === undefined ? "" : String(body[key]);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(24), b => alphabet[b % alphabet.length]).join("");
}

const digitsOnly = v => String(v || "").replace(/\D/g, "");
const roomFor = (prefix, uuid) => `${prefix}${String(uuid || crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "")}`;
/** The end-of-call notification, which Vobiz posts to the answer URL as well. */
const isHangup = body => field(body, "Event") === "Hangup" || field(body, "CallStatus").toLowerCase() === "completed";
/** The SIP username in a From such as "sip:agentone123@registrar.vobiz.ai". */
const sipUserOf = from => String(from || "").replace(/^sips?:/i, "").split("@")[0];

/* ------------------------------------------------------------------ *
 * Vobiz REST API
 * ------------------------------------------------------------------ */

async function vobiz(cfg, creds, method, suffix, body) {
  const url = suffix.startsWith("/api/") ? `${cfg.apiBase}${suffix}` : `${cfg.apiBase}/api/v1/Account/${encodeURIComponent(creds.authId)}${suffix}`;
  const init = { method, headers: { "X-Auth-ID": creds.authId, "X-Auth-Token": creds.authToken } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json };
}

/** Find an Application by name, pointing it at `answerUrl`; create it if absent. */
async function ensureApplication(cfg, creds, appName, answerUrl) {
  const list = await vobiz(cfg, creds, "GET", "/Application/?limit=100");
  const existing = list.ok ? ((list.json && list.json.objects) || []).find(a => a.app_name === appName) : null;
  if (existing) {
    if (existing.answer_url !== answerUrl || existing.hangup_url !== answerUrl) {
      const upd = await vobiz(cfg, creds, "POST", `/Application/${existing.app_id}/`, {
        answer_url: answerUrl, answer_method: "POST", hangup_url: answerUrl, hangup_method: "POST",
      });
      if (!upd.ok) throw new Error(`could not update application ${appName}: ${upd.status}`);
      log(`application ${appName} now points at ${answerUrl}`);
    }
    return existing.app_id;
  }
  const created = await vobiz(cfg, creds, "POST", "/Application/", {
    app_name: appName, answer_url: answerUrl, answer_method: "POST", hangup_url: answerUrl, hangup_method: "POST",
  });
  if (!created.ok || !created.json || !created.json.app_id) {
    // A freshly created tunnel hostname that does not resolve yet is refused with 400.
    throw new Error(`could not create application ${appName}: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  log(`created application ${appName} -> ${answerUrl}`);
  return created.json.app_id;
}

/**
 * The endpoint the panel registers as, found by alias so signing in again
 * reuses it. Its password cannot be read back, so each sign-in sets a new one.
 */
async function ensureEndpoint(cfg, creds, agentId, appId) {
  const alias = `vobiz-sf-${agentId}`.slice(0, 60);
  const password = generatePassword();
  const list = await vobiz(cfg, creds, "GET", `/Endpoint/?alias__exact=${encodeURIComponent(alias)}&limit=5`);
  const existing = list.ok ? ((list.json && list.json.objects) || []).find(e => e.alias === alias) : null;
  if (existing) {
    const upd = await vobiz(cfg, creds, "POST", `/Endpoint/${existing.endpoint_id}/`, { alias, password });
    if (!upd.ok) throw new Error(`could not set the endpoint password: ${upd.status}`);
    return { username: existing.username, password };
  }
  const created = await vobiz(cfg, creds, "POST", "/Endpoint/", {
    username: `vobizsf${agentId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 30),
    password,
    alias,
    application: Number(appId),
  });
  // Vobiz may append a suffix to the requested username; register as the stored one.
  if (!created.ok || !created.json || !created.json.username) {
    throw new Error(`could not create the endpoint: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  log(`created endpoint ${created.json.username} for "${agentId}"`);
  return { username: created.json.username, password };
}

async function endConference(cfg, creds, room) {
  if (!creds || !room) return;
  const r = await vobiz(cfg, creds, "DELETE", `/Conference/${encodeURIComponent(room)}/`).catch(e => ({ ok: false, status: e.message }));
  // 404: nobody is in it any more, which is what was wanted.
  if (!r.ok && r.status !== 404) warn(`ending room ${room} returned ${r.status}`);
}

async function hangupCall(cfg, creds, callUuid) {
  if (!creds || !callUuid) return true;
  const r = await vobiz(cfg, creds, "DELETE", `/Call/${encodeURIComponent(callUuid)}/`).catch(e => ({ ok: false, status: e.message }));
  // 404: the caller already hung up — the state being asked for.
  if (!r.ok && r.status !== 404) { warn(`hanging up ${callUuid} returned ${r.status}`); return false; }
  return true;
}

/* ------------------------------------------------------------------ *
 * Webhook signatures
 *
 * X-Vobiz-Signature-V3 = base64(HMAC-SHA256(authToken, baseUrl + "." + nonce))
 * where baseUrl is the callback URL without its query string. V2 is the same
 * without the ".". The signature covers the URL and nonce, never the body.
 * ------------------------------------------------------------------ */

function signatureCheck(cfg, req, url, authToken) {
  const v3 = req.headers["x-vobiz-signature-v3"];
  const v2 = req.headers["x-vobiz-signature-v2"];
  if (!v3 && !v2) return cfg.requireSignature ? "missing" : "absent";
  if (!authToken) return "unverifiable";
  const base = `${cfg.publicBaseUrl}${url.pathname}`;
  const attempts = [];
  if (v3) attempts.push([v3, `${base}.${req.headers["x-vobiz-signature-v3-nonce"] || ""}`]);
  if (v2) attempts.push([v2, `${base}${req.headers["x-vobiz-signature-v2-nonce"] || ""}`]);
  for (const [given, message] of attempts) {
    const expected = crypto.createHmac("sha256", authToken).update(message).digest("base64");
    const a = Buffer.from(String(given));
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return "valid";
  }
  return "invalid";
}

/** True when the webhook may proceed. Refuses a bad signature, and a missing one when required. */
function webhookAllowed(cfg, req, url, creds) {
  const result = signatureCheck(cfg, req, url, creds && creds.authToken);
  if (result === "invalid" || result === "missing") {
    warn(`${url.pathname}: signature ${result} — refusing. If every call fails this way, PUBLIC_BASE_URL does not match the URL Vobiz was given.`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

function sessionFor(req, agentId) {
  const sid = parseCookies(req)[COOKIE];
  const s = sid && state.sessions.get(sid);
  if (!s || s.expires < Date.now()) return null;
  if (agentId !== undefined && s.agentId !== agentId) return null;
  return s;
}

/** The credentials to act for an agent with — their session, never another's. */
function credsForAgent(agentId) {
  const sid = state.sessionByAgent.get(agentId);
  const s = sid && state.sessions.get(sid);
  return s && s.expires >= Date.now() ? s : null;
}

function accountCreds(cfg) {
  return cfg.accountAuthId && cfg.accountAuthToken ? { authId: cfg.accountAuthId, authToken: cfg.accountAuthToken } : null;
}

function sessionCookie(cfg, sid, maxAgeSec) {
  // SameSite=None and Partitioned because the panel runs in a frame inside
  // Salesforce, where any other cookie is treated as third-party and dropped.
  return `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSec}`;
}

/**
 * The panel's own requests are same-origin. Requiring a JSON body forces a CORS
 * preflight on anything cross-site, and this server answers no preflight, so a
 * page elsewhere cannot drive these endpoints with the agent's cookie.
 */
function panelPostAllowed(cfg, req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const own = [cfg.publicBaseUrl, `http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`];
  return own.some(o => o && new URL(o).origin === origin);
}

async function panelJson(req) {
  try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; }
}

/* ------------------------------------------------------------------ *
 * VobizXML documents
 * ------------------------------------------------------------------ */

const recordTag = (_cfg, on) => on
  // A sibling BEFORE <Conference>, never nested: nested, the whole document is
  // rejected and the caller hears a bogus "busy".
  ? `  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"/>\n`
  : "";

function xmlParkInbound(cfg, agentId, room, callUuid) {
  const cb = `${cfg.publicBaseUrl}/conf-event?agentId=${encodeURIComponent(agentId)}&room=${encodeURIComponent(room)}&role=caller&call=${encodeURIComponent(callUuid)}`;
  return `<Response>
  <Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"
    waitSound="${escapeXml(`${cfg.publicBaseUrl}/conf-wait`)}" timeLimit="3600"
    callbackUrl="${escapeXml(cb)}" callbackMethod="POST">${escapeXml(room)}</Conference>
${xmlVoicemailBody()}</Response>`;
}

function xmlVoicemailBody() {
  return `  <Speak>Sorry, nobody is available to take your call. Please leave a message after the beep.</Speak>
  <Record maxLength="120" timeout="10" finishOnKey="#" playBeep="true" fileFormat="mp3"/>
  <Hangup/>
`;
}

const xmlVoicemail = () => `<Response>\n${xmlVoicemailBody()}</Response>`;

function xmlAgentJoinsCaller(cfg, agentId, room, record) {
  const cb = `${cfg.publicBaseUrl}/conf-event?agentId=${encodeURIComponent(agentId)}&room=${encodeURIComponent(room)}&role=agent`;
  return `<Response>
${recordTag(cfg, record)}  <Conference startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="false" timeLimit="3600"
    callbackUrl="${escapeXml(cb)}" callbackMethod="POST">${escapeXml(room)}</Conference>
  <Hangup/>
</Response>`;
}

function xmlAgentWaits(cfg, agentId, room, record) {
  const cb = `${cfg.publicBaseUrl}/conf-event?agentId=${encodeURIComponent(agentId)}&room=${encodeURIComponent(room)}&role=agent`;
  return `<Response>
${recordTag(cfg, record)}  <Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"
    waitSound="${escapeXml(`${cfg.publicBaseUrl}/outbound-wait`)}" timeLimit="14400"
    callbackUrl="${escapeXml(cb)}" callbackMethod="POST">${escapeXml(room)}</Conference>
  <Hangup/>
</Response>`;
}

function xmlDestinationJoins(cfg, room) {
  const cb = `${cfg.publicBaseUrl}/conf-event?room=${encodeURIComponent(room)}&role=destination`;
  return `<Response>
  <Conference startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="true" timeLimit="14400"
    callbackUrl="${escapeXml(cb)}" callbackMethod="POST">${escapeXml(room)}</Conference>
  <Hangup/>
</Response>`;
}

/* ------------------------------------------------------------------ *
 * Panel endpoints
 * ------------------------------------------------------------------ */

async function handleLogin(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, authId, authToken } = await panelJson(req);
  if (!AGENT_ID.test(String(agentId || ""))) return sendJson(res, 400, { error: "agentId must be 1-40 letters, digits, - or _" });
  if (!authId || !authToken) return sendJson(res, 400, { error: "Enter both an Auth ID and an Auth Token." });

  const creds = { authId: String(authId).trim(), authToken: String(authToken).trim() };
  const numbersRes = await vobiz(cfg, creds, "GET", "/numbers?per_page=100").catch(() => ({ ok: false, status: 502 }));
  if (!numbersRes.ok) {
    warn(`login for "${agentId}" refused by Vobiz (${numbersRes.status})`);
    return sendJson(res, 401, { error: "Vobiz rejected that Auth ID and Auth Token." });
  }
  const numbers = (((numbersRes.json && (numbersRes.json.items || numbersRes.json.objects)) || []))
    .map(n => n.e164 || n.number)
    .filter(Boolean);

  // One live session per agentId: signing in again replaces the old one.
  const previous = state.sessionByAgent.get(agentId);
  if (previous) state.sessions.delete(previous);
  const sid = crypto.randomBytes(32).toString("hex");
  const maxAge = Math.round(cfg.sessionHours * 3600);
  state.sessions.set(sid, {
    sid, agentId, ...creds, numbers, from: numbers[0] || null, sip: null, expires: Date.now() + maxAge * 1000,
  });
  state.sessionByAgent.set(agentId, sid);
  log(`"${agentId}" signed in as ${creds.authId} — ${numbers.length} number(s)`);
  sendJson(res, 200, { numbers, selected: numbers[0] || null }, { "Set-Cookie": sessionCookie(cfg, sid, maxAge) });
}

function handleSession(cfg, req, res, agentId) {
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 200, { loggedIn: false });
  sendJson(res, 200, { loggedIn: true, numbers: s.numbers, from: s.from, authId: s.authId });
}

async function handleAgent(cfg, req, res, agentId) {
  const s = sessionFor(req, agentId);
  // Never a SIP password without a session for exactly this agent. Before
  // sign-in the panel is told there is no line yet, which it shows as
  // "Sign in below" rather than as a configuration error.
  if (!s) return sendJson(res, 200, { displayName: agentId, provisioned: false });
  if (!s.sip) {
    if (!cfg.publicBaseUrl) return sendJson(res, 500, { error: "PUBLIC_BASE_URL is not set on the backend" });
    try {
      const appId = await ensureApplication(cfg, s, `VobizSF_${agentId}`, `${cfg.publicBaseUrl}/answer?agentId=${encodeURIComponent(agentId)}`);
      const ep = await ensureEndpoint(cfg, s, agentId, appId);
      s.sip = { username: ep.username, password: ep.password };
    } catch (err) {
      warn(`provisioning "${agentId}" failed: ${err.message}`);
      return sendJson(res, 502, { error: err.message });
    }
  }
  sendJson(res, 200, {
    displayName: agentId,
    sipUser: `${s.sip.username}@registrar.vobiz.ai`,
    sipPassword: s.sip.password,
    provisioned: true,
  });
}

async function handleSelectNumber(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, number } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { error: "Sign in first." });
  if (!s.numbers.includes(number)) return sendJson(res, 400, { error: "That number is not on this account." });
  s.from = number;
  sendJson(res, 200, { selected: number });
}

async function handleSetupInbound(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { error: "Sign in on the Vobiz account tab first — routing a number is an account-level change." });
  if (!s.from) return sendJson(res, 400, { error: "This account has no number to route." });
  if (!cfg.publicBaseUrl) return sendJson(res, 500, { error: "PUBLIC_BASE_URL is not set on the backend" });
  try {
    const appId = await ensureApplication(cfg, s, `VobizSF_in_${agentId}`, `${cfg.publicBaseUrl}/inbound-answer?agentId=${encodeURIComponent(agentId)}`);
    const attach = await vobiz(cfg, s, "POST", `/numbers/${encodeURIComponent(s.from)}/application`, { application_id: String(appId) });
    if (!attach.ok) throw new Error(`attaching ${s.from} returned ${attach.status}`);
    log(`inbound calls to ${s.from} now ring "${agentId}"`);
    sendJson(res, 200, { number: s.from });
  } catch (err) {
    warn(`setup-inbound for "${agentId}" failed: ${err.message}`);
    sendJson(res, 502, { error: err.message });
  }
}

function handleInboundPending(cfg, req, res, agentId) {
  if (!sessionFor(req, agentId)) return sendJson(res, 401, { pending: false, error: "Sign in first." });
  state.lastPoll.set(agentId, Date.now());
  const p = state.pending.get(agentId);
  if (!p || p.state !== "ringing") return sendJson(res, 200, { pending: false });
  sendJson(res, 200, { pending: true, room: p.room, from: p.from, to: p.to, callUuid: p.callUuid });
}

function clearPending(agentId) {
  const p = state.pending.get(agentId);
  if (p && p.timer) clearTimeout(p.timer);
  state.pending.delete(agentId);
  return p;
}

async function handleInboundAccept(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  const p = state.pending.get(agentId);
  if (!p || p.state !== "ringing") return sendJson(res, 200, { ok: false, reason: "the call is no longer ringing" });

  // Stop the no-answer timer now, before the browser's leg arrives: getting
  // the microphone and gathering ICE take seconds, and a slow join must not
  // race the caller into voicemail.
  if (p.timer) clearTimeout(p.timer);
  p.state = "accepted";
  // A backstop in case the browser's leg never arrives at all.
  p.timer = setTimeout(() => {
    if (state.pending.get(agentId) !== p) return;
    warn(`"${agentId}" accepted ${p.callUuid} but never joined — sending the caller to voicemail`);
    clearPending(agentId);
    endConference(cfg, s, p.room);
  }, JOIN_WINDOW_MS).unref();
  state.joinExpected.set(agentId, { room: p.room, from: p.from, callUuid: p.callUuid, at: Date.now(), callerGone: false });
  sendJson(res, 200, { ok: true, room: p.room, from: p.from, callUuid: p.callUuid });
}

async function handleInboundDecline(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  const p = clearPending(agentId);
  // Ending the room drops the caller out of <Conference> and on to voicemail.
  if (p) await endConference(cfg, s, p.room);
  sendJson(res, 200, { ok: true });
}

async function handleInboundHangup(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, callUuid } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  // Only the caller this agent was offered — never an arbitrary call on the account.
  if (!callUuid || state.inboundCalls.get(callUuid) !== agentId) return sendJson(res, 200, { ok: false, reason: "not your call" });
  state.joinExpected.delete(agentId);
  const p = state.pending.get(agentId);
  if (p && p.callUuid === callUuid) clearPending(agentId);
  state.inboundCalls.delete(callUuid);
  // A hangup, not ending the room: ending it would play the caller the
  // voicemail greeting after a finished conversation.
  const ok = await hangupCall(cfg, s, callUuid);
  sendJson(res, 200, { ok });
}

/* ------------------------------------------------------------------ *
 * Webhooks Vobiz calls
 * ------------------------------------------------------------------ */

async function handleInboundAnswer(cfg, req, res, url) {
  const agentId = url.searchParams.get("agentId") || "";
  const s = credsForAgent(agentId);
  if (!webhookAllowed(cfg, req, url, s || accountCreds(cfg))) return sendXml(res, HANGUP);
  const body = await webhookFields(req, url);
  const callUuid = field(body, "CallUUID");
  const from = field(body, "From");

  if (isHangup(body)) {
    // The caller hung up. A browser leg still on its way must not ring them back.
    const p = state.pending.get(agentId);
    if (p && p.callUuid === callUuid) clearPending(agentId);
    const j = state.joinExpected.get(agentId);
    if (j && j.callUuid === callUuid) j.callerGone = true;
    return sendXml(res, EMPTY);
  }

  const lastPoll = state.lastPoll.get(agentId) || 0;
  if (!s || Date.now() - lastPoll > PRESENCE_MS) {
    // Nobody's panel is open: straight to voicemail, not two minutes of hold music.
    log(`inbound from ${from} for "${agentId}" — no panel listening, voicemail`);
    return sendXml(res, xmlVoicemail());
  }
  if (state.pending.has(agentId)) {
    log(`inbound from ${from} for "${agentId}" — already ringing with another caller, voicemail`);
    return sendXml(res, xmlVoicemail());
  }

  const room = roomFor("in", callUuid);
  const p = { room, from, to: field(body, "To"), callUuid, state: "ringing", timer: null };
  p.timer = setTimeout(() => {
    if (state.pending.get(agentId) !== p || p.state !== "ringing") return;
    log(`inbound ${callUuid} for "${agentId}" not answered in ${cfg.inboundRingSeconds}s — voicemail`);
    clearPending(agentId);
    endConference(cfg, s, room);
  }, cfg.inboundRingSeconds * 1000).unref();
  state.pending.set(agentId, p);
  state.inboundCalls.set(callUuid, agentId);
  log(`inbound from ${from} parked in ${room} for "${agentId}"`);
  sendXml(res, xmlParkInbound(cfg, agentId, room, callUuid));
}

async function handleAnswer(cfg, req, res, url) {
  const agentId = url.searchParams.get("agentId") || "";
  const session = agentId ? credsForAgent(agentId) : null;
  const sipDirect = !agentId;
  const creds = sipDirect ? accountCreds(cfg) : session;
  if (!webhookAllowed(cfg, req, url, creds)) return sendXml(res, HANGUP);

  const body = await webhookFields(req, url);
  const callUuid = field(body, "CallUUID");

  // The hangup notification arrives at this same URL. Answering it with call
  // XML would start a new leg after the call has ended.
  if (isHangup(body)) {
    for (const [room, r] of state.outboundRooms) {
      if (r.agentLeg === callUuid && !r.answered) { r.closed = true; endConference(cfg, r.creds, room); }
    }
    return sendXml(res, EMPTY);
  }

  const from = field(body, "From");
  const browserIsALeg = /^sips?:/i.test(from) || field(body, "RouteType").toLowerCase() === "sip";
  if (!browserIsALeg) {
    warn(`/answer: a call from ${from} is not a browser leg — this URL only serves the panel`);
    return sendXml(res, HANGUP);
  }

  // Only this agent's own endpoint may spend this agent's account. Without
  // this, anyone who can POST to /answer could dial any number on your bill.
  const caller = sipUserOf(from);
  if (sipDirect) {
    if (!creds || !cfg.sipDirectUsers.has(caller)) {
      warn(`/answer: SIP direct call from "${caller}" refused — set VOBIZ_AUTH_ID/TOKEN and list it in SIP_DIRECT_USERNAMES`);
      return sendXml(res, `<Response><Speak>This phone line is not enabled for calling.</Speak><Hangup/></Response>`);
    }
  } else if (!session || !session.sip || session.sip.username !== caller) {
    warn(`/answer: call from "${caller}" does not match the signed-in endpoint for "${agentId}" — refused`);
    return sendXml(res, `<Response><Speak>Please sign in to the softphone again.</Speak><Hangup/></Response>`);
  }

  const record = ["true", "1", "yes", "on"].includes(field(body, "X-VH-Record").trim().toLowerCase());

  // Is this leg the agent coming to meet a waiting caller? Checked BEFORE the
  // dialled number: the browser dialled the caller's own number to get here,
  // so dialling it now would ring them back.
  const join = agentId && state.joinExpected.get(agentId);
  if (join && Date.now() - join.at <= JOIN_WINDOW_MS) {
    state.joinExpected.delete(agentId);
    if (join.callerGone) {
      return sendXml(res, `<Response><Speak>That caller has already hung up.</Speak><Hangup/></Response>`);
    }
    log(`"${agentId}" joining ${join.room} (caller ${join.from})`);
    return sendXml(res, xmlAgentJoinsCaller(cfg, agentId, join.room, record));
  }
  if (join) state.joinExpected.delete(agentId);

  // A genuine outbound call: the agent waits in a room, the destination is
  // dialled into it over the REST API.
  const to = digitsOnly(field(body, "To").replace(/^sips?:/i, "").split("@")[0]);
  if (to.length < 6 || to.length > 15) {
    return sendXml(res, `<Response><Speak>That number could not be dialled.</Speak><Hangup/></Response>`);
  }
  const headerCli = field(body, "X-VH-Caller-ID").replace(/[^\d+]/g, "");
  let callerId;
  if (sipDirect) callerId = headerCli;
  else callerId = headerCli && session.numbers.includes(headerCli) ? headerCli : session.from;
  if (!callerId) {
    return sendXml(res, `<Response><Speak>No caller ID is set for this phone line.</Speak><Hangup/></Response>`);
  }

  const room = roomFor("ob", callUuid);
  if (state.outboundRooms.has(room)) {
    // Vobiz can fetch an answer URL twice for one call; do not dial twice.
    return sendXml(res, xmlAgentWaits(cfg, agentId, room, record));
  }
  const r = { creds, agentId, agentLeg: callUuid, legs: new Set(), answered: false, closed: false, timer: null };
  r.timer = setTimeout(() => {
    if (r.answered || r.closed) return;
    log(`outbound ${room}: ${to} did not answer — ending the room`);
    r.closed = true;
    endConference(cfg, creds, room);
  }, (cfg.outboundRingSeconds + 5) * 1000).unref();
  state.outboundRooms.set(room, r);

  // Not awaited: the agent's leg must reach the room before the destination can answer into it.
  vobiz(cfg, creds, "POST", "/Call/", {
    from: callerId,
    to,
    answer_url: `${cfg.publicBaseUrl}/outbound-join?room=${encodeURIComponent(room)}`,
    answer_method: "GET",
    hangup_url: `${cfg.publicBaseUrl}/outbound-hangup?room=${encodeURIComponent(room)}`,
    hangup_method: "POST",
    ring_timeout: String(cfg.outboundRingSeconds),
  }).then(result => {
    if (result.ok) { log(`outbound ${room}: dialling ${to} from ${callerId}`); return; }
    warn(`outbound ${room}: Vobiz refused to dial ${to}: ${result.status} ${JSON.stringify(result.json).slice(0, 200)}`);
    r.closed = true;
    endConference(cfg, creds, room);
  }).catch(err => {
    warn(`outbound ${room}: ${err.message}`);
    r.closed = true;
    endConference(cfg, creds, room);
  });

  sendXml(res, xmlAgentWaits(cfg, agentId, room, record));
}

async function handleOutboundJoin(cfg, req, res, url) {
  const room = url.searchParams.get("room") || "";
  const r = state.outboundRooms.get(room);
  if (!r || !webhookAllowed(cfg, req, url, r.creds)) return sendXml(res, HANGUP);
  // The agent gave up while this phone was ringing: do not seat them in an empty room.
  if (r.closed) return sendXml(res, HANGUP);
  sendXml(res, xmlDestinationJoins(cfg, room));
}

async function handleOutboundHangup(cfg, req, res, url) {
  const room = url.searchParams.get("room") || "";
  const r = state.outboundRooms.get(room);
  if (r && webhookAllowed(cfg, req, url, r.creds) && !r.answered && !r.closed) {
    // Busy, rejected or unanswered: release the agent rather than leave them waiting.
    log(`outbound ${room}: destination leg ended before answering — releasing the agent`);
    r.closed = true;
    endConference(cfg, r.creds, room);
  }
  sendXml(res, EMPTY);
}

async function handleConfEvent(cfg, req, res, url) {
  const body = await webhookFields(req, url);
  const room = url.searchParams.get("room") || field(body, "ConferenceName");
  const role = url.searchParams.get("role") || "";
  const agentId = url.searchParams.get("agentId") || "";
  const action = field(body, "ConferenceAction").toLowerCase();
  const leg = field(body, "CallUUID");

  const r = state.outboundRooms.get(room);
  const creds = r ? r.creds : credsForAgent(agentId);
  if (!webhookAllowed(cfg, req, url, creds)) return sendXml(res, EMPTY);

  if (r) {
    if (action === "enter") {
      r.legs.add(leg || role);
      if (r.legs.size >= 2 && !r.answered) {
        r.answered = true;
        if (r.timer) clearTimeout(r.timer);
        log(`outbound ${room}: answered`);
      }
    } else if (action === "exit") {
      r.legs.delete(leg || role);
      if (r.legs.size === 0) {
        if (r.timer) clearTimeout(r.timer);
        state.outboundRooms.delete(room);
        log(`outbound ${room}: call over`);
      }
    }
  } else if (role === "agent" && action === "enter") {
    // Both legs are in the inbound room; the offer is over.
    const p = state.pending.get(agentId);
    if (p && p.room === room) clearPending(agentId);
  } else if (role === "caller" && action === "exit") {
    const p = state.pending.get(agentId);
    if (p && p.room === room) clearPending(agentId);
    const j = state.joinExpected.get(agentId);
    if (j && j.room === room) j.callerGone = true;
  }
  sendXml(res, EMPTY);
}

/* ------------------------------------------------------------------ *
 * The panel's own files
 * ------------------------------------------------------------------ */

function servePanel(cfg, req, res, name) {
  const type = Object.prototype.hasOwnProperty.call(PANEL_FILES, name) && PANEL_FILES[name];
  if (!type) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
  fs.readFile(path.join(APP_DIR, name), (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Only Salesforce may frame the panel.
      "Content-Security-Policy": `frame-ancestors ${cfg.frameAncestors}; object-src 'none'; base-uri 'none'`,
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

function createServer(cfg = config()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const m = req.method;
    const tail = prefix => decodeURIComponent(p.slice(prefix.length));
    try {
      if (m === "GET" && p === "/healthz") return sendJson(res, 200, { ok: true });
      if (m === "GET" && p.startsWith("/salesforce/")) return servePanel(cfg, req, res, p.slice("/salesforce/".length));

      // Panel endpoints
      if (m === "POST" && p === "/login") return await handleLogin(cfg, req, res);
      if (m === "GET" && p.startsWith("/session/")) return handleSession(cfg, req, res, tail("/session/"));
      if (m === "GET" && p.startsWith("/agent/")) return await handleAgent(cfg, req, res, tail("/agent/"));
      if (m === "POST" && p === "/select-number") return await handleSelectNumber(cfg, req, res);
      if (m === "POST" && p === "/setup-inbound") return await handleSetupInbound(cfg, req, res);
      if (m === "GET" && p.startsWith("/inbound-pending/")) return handleInboundPending(cfg, req, res, tail("/inbound-pending/"));
      if (m === "POST" && p === "/inbound-accept") return await handleInboundAccept(cfg, req, res);
      if (m === "POST" && p === "/inbound-decline") return await handleInboundDecline(cfg, req, res);
      if (m === "POST" && p === "/inbound-hangup") return await handleInboundHangup(cfg, req, res);

      // Webhooks
      if (p === "/answer") return await handleAnswer(cfg, req, res, url);
      if (p === "/inbound-answer") return await handleInboundAnswer(cfg, req, res, url);
      if (p === "/outbound-join") return await handleOutboundJoin(cfg, req, res, url);
      if (p === "/outbound-hangup") return await handleOutboundHangup(cfg, req, res, url);
      if (p === "/conf-event") return await handleConfEvent(cfg, req, res, url);
      if (p === "/conf-wait") return sendXml(res, `<Response><Speak>Please hold while we connect you.</Speak><Wait length="8"/></Response>`);
      if (p === "/outbound-wait") return sendXml(res, `<Response><Wait length="3"/></Response>`);

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (err) {
      warn(`${m} ${p}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  });
}

function resetState() { state = freshState(); }

module.exports = { createServer, config, resetState };

if (require.main === module) {
  const cfg = config();
  if (!cfg.publicBaseUrl) {
    console.error("PUBLIC_BASE_URL is not set. Start a tunnel to this port and set it to the tunnel's https:// address.");
    process.exit(1);
  }
  createServer(cfg).listen(cfg.port, () => {
    log(`listening on :${cfg.port}`);
    log(`panel:   ${cfg.publicBaseUrl}/salesforce/softphone.html?org=<your My Domain>&agentId=<agent>`);
    log(`webhooks: ${cfg.publicBaseUrl}/answer, ${cfg.publicBaseUrl}/inbound-answer`);
  });
}
