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
    // Where the endpoint map ({authId:agentId -> endpoint id, username}) is
    // kept between restarts. Never a password or a token. Git-ignored.
    dataDir: env.DATA_DIR || path.join(__dirname, "data"),
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
 *
 * Any Vobiz account can sign in, and two accounts can be signed in at once.
 * Everything about an agent is therefore keyed by ACCOUNT and agent together
 * ("<authId>:<agentId>"), never by the agent id alone: two Salesforce orgs on
 * two Vobiz accounts may well both call their first agent "agent-one".
 * ------------------------------------------------------------------ */

function freshState() {
  return {
    /** authId -> { authId, authToken, numbers }. The token lives here and nowhere else: never sent to a browser, logged or written to disk. */
    accounts: new Map(),
    /** sid -> { sid, authId, agentId, key, numbers, from, sip, expires } */
    sessions: new Map(),
    /** agent key -> sid of their current session */
    sessionByAgent: new Map(),
    /** SIP username -> agent key, for endpoints this backend provisioned. How /answer knows whose browser is calling. */
    sipUsers: new Map(),
    /** SIP direct: typed SIP username -> { sid, callerId }. No account credentials behind it at all. */
    sipDirect: new Map(),
    /** agent key -> ms of the panel's last /inbound-pending poll */
    lastPoll: new Map(),
    /** agent key -> the inbound offer ringing (or accepted) on that agent's panel */
    pending: new Map(),
    /** inbound room -> offer { room, authId, from, to, callUuid, state, timer, offered: Set<key>, acceptedBy } */
    inboundRooms: new Map(),
    /** inbound caller CallUUID -> offer */
    inboundCalls: new Map(),
    /** agent key -> { room, from, callUuid, at, callerGone } */
    joinExpected: new Map(),
    /** outbound room -> { authId, agentKey, agentLeg, legs: Set, answered, closed, timer } */
    outboundRooms: new Map(),
    /** endpoint map loaded from disk: { dir, map: { "<authId>:<agentId>": { endpointId, username } } } */
    endpointStore: null,
  };
}
let state = freshState();

const agentKey = (authId, agentId) => `${authId}:${agentId}`;

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
/** A strict E.164 number, or "" — "+", a non-zero country digit, 8 to 15 digits in all. */
function cleanPhone(v) {
  const s = String(v || "").trim().replace(/[\s().-]/g, "");
  const e = s.startsWith("+") ? s : `+${s}`;
  return /^\+[1-9]\d{7,14}$/.test(e) ? e : "";
}
/** A dialled DID as E.164: an 11-digit 0XXXXXXXXXX is Indian national format. */
function normalizeDid(v) {
  const d = String(v || "").replace(/^sips?:/i, "").split("@")[0].replace(/[^\d+]/g, "");
  if (/^0\d{10}$/.test(d)) return `+91${d.slice(1)}`;
  return d.startsWith("+") ? d : d ? `+${d}` : "";
}
/** An X-VH-* header as the answer webhook delivers it: top-level, sometimes prefixed SIPHeader_. */
const vhField = (body, name) => field(body, name) || field(body, `SIPHeader_${name}`);
const toE164 = v => { const d = digitsOnly(v); return d ? `+${d}` : ""; };
const roomFor = (prefix, uuid) => `${prefix}${String(uuid || crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "")}`;
/** The end-of-call notification, which Vobiz posts to the answer URL as well. */
const isHangup = body => field(body, "Event") === "Hangup" || field(body, "CallStatus").toLowerCase() === "completed";
/** The SIP username in a From such as "sip:agentone123@registrar.vobiz.ai". */
const sipUserOf = from => String(from || "").replace(/^sips?:/i, "").split("@")[0];

/* ------------------------------------------------------------------ *
 * Vobiz REST API
 *
 * Application ids are 17 digits — past Number.MAX_SAFE_INTEGER — so an id is
 * never allowed to become a JavaScript number. Responses are parsed with every
 * id field turned into a string first, and the one request that must send an
 * id as a JSON integer (binding an endpoint) splices the digits into the body
 * text instead of going through JSON.stringify.
 * ------------------------------------------------------------------ */

const ID_FIELDS = /("(?:app_id|application_id|application|endpoint_id)"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g;

/** JSON.parse, with integer id fields kept as exact strings. */
function parseVobizJson(text) {
  return JSON.parse(String(text).replace(ID_FIELDS, '$1"$2"'));
}

/**
 * One call to the Vobiz REST API. `body` is an object to JSON-encode, or a
 * string sent as-is (used when the body must carry a 17-digit integer).
 */
async function vobiz(cfg, creds, method, suffix, body) {
  const url = suffix.startsWith("/api/") ? `${cfg.apiBase}${suffix}` : `${cfg.apiBase}/api/v1/Account/${encodeURIComponent(creds.authId)}${suffix}`;
  const init = { method, headers: { "X-Auth-ID": creds.authId, "X-Auth-Token": creds.authToken } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? parseVobizJson(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json, text };
}

const isId = v => /^\d+$/.test(String(v || ""));

/** Every page of a list endpoint (limit 100, the documented maximum). */
async function listAll(cfg, creds, suffix) {
  const out = [];
  for (let page = 0; page < 20; page++) {
    const sep = suffix.includes("?") ? "&" : "?";
    const r = await vobiz(cfg, creds, "GET", `${suffix}${sep}limit=100&offset=${page * 100}`);
    if (!r.ok) throw new Error(`listing ${suffix} returned ${r.status}`);
    const objects = (r.json && r.json.objects) || [];
    out.push(...objects);
    if (objects.length < 100) break;
  }
  return out;
}

/**
 * This integration's Application in this account, found by its answer URL
 * and created when absent. An application whose answer URL is anything else is
 * someone else's and is never touched, let alone repointed.
 */
async function ensureApplication(cfg, creds, appName, answerUrl) {
  const existing = (await listAll(cfg, creds, "/Application/")).find(a => a.answer_url === answerUrl);
  if (existing && isId(existing.app_id)) return String(existing.app_id);
  const created = await vobiz(cfg, creds, "POST", "/Application/", {
    app_name: appName, answer_url: answerUrl, answer_method: "POST", hangup_url: answerUrl, hangup_method: "POST",
  });
  const appId = created.json && created.json.app_id;
  if (!created.ok || !isId(appId)) {
    // A freshly created tunnel hostname that does not resolve yet is refused with 400.
    throw new Error(`could not create application ${appName}: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  log(`created application ${appName} in ${creds.authId} -> ${answerUrl}`);
  return String(appId);
}

/* ---- the endpoint map on disk ---- */

function endpointStore(cfg) {
  if (state.endpointStore && state.endpointStore.dir === cfg.dataDir) return state.endpointStore;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "endpoints.json"), "utf8")) || {}; } catch { /* first run */ }
  state.endpointStore = { dir: cfg.dataDir, map };
  return state.endpointStore;
}

function saveEndpointStore(cfg) {
  const store = endpointStore(cfg);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(cfg.dataDir, "endpoints.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store.map, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** The application an endpoint is bound to, read from the raw response text. */
function boundAppId(text) {
  const t = String(text || "");
  const m = /"application"\s*:\s*\{[^}]*?"app_id"\s*:\s*"?(\d+)/.exec(t)
    || /"application"\s*:\s*"?(\d+)"?\s*[,}]/.exec(t)
    || /"application"\s*:\s*"[^"]*\/Application\/(\d+)\/?"/.exec(t)
    || /"app_id"\s*:\s*"?(\d+)/.exec(t);
  return m ? m[1] : null;
}

/**
 * Point an endpoint at an application. First `{"app_id":"<id>"}` — the id as
 * a string, which is what Vobiz's own playground sends — then read back. If it
 * did not take, the documented `{"application": <app_id>}`, with the integer
 * spliced into the body as text so all 17 digits survive. Logged either way.
 */
async function bindEndpoint(cfg, creds, endpointId, appId) {
  if (!isId(appId)) throw new Error(`refusing to bind to a malformed application id`);
  const first = await vobiz(cfg, creds, "POST", `/Endpoint/${endpointId}/`, `{"app_id":"${appId}"}`);
  let info = await vobiz(cfg, creds, "GET", `/Endpoint/${endpointId}/`);
  if (boundAppId(info.text) === appId) {
    log(`endpoint ${endpointId} bound to application ${appId}`);
    return info;
  }
  warn(`endpoint ${endpointId}: app_id bind returned ${first.status} but reads back ${boundAppId(info.text) || "no application"} — retrying with application`);
  await vobiz(cfg, creds, "POST", `/Endpoint/${endpointId}/`, `{"application":${appId}}`);
  info = await vobiz(cfg, creds, "GET", `/Endpoint/${endpointId}/`);
  if (boundAppId(info.text) === appId) log(`endpoint ${endpointId} bound to application ${appId} on retry`);
  else warn(`endpoint ${endpointId} is still not bound to application ${appId} — calls from it will not reach this backend`);
  return info;
}

/**
 * The one endpoint for (account, agent): found from the map on disk, or by its
 * alias if the map was lost, or created. Every sign-in sets a fresh random
 * password, which only that browser session is given. Vobiz may rewrite the
 * requested username, so the stored one is always read back.
 */
async function ensureEndpoint(cfg, creds, agentId, appId) {
  const key = agentKey(creds.authId, agentId);
  const store = endpointStore(cfg);
  const alias = `vobiz-sf-${agentId}`.slice(0, 60);
  const password = generatePassword();

  let endpointId = store.map[key] && store.map[key].endpointId;
  if (endpointId) {
    const found = await vobiz(cfg, creds, "GET", `/Endpoint/${endpointId}/`);
    if (found.status === 404) endpointId = null;
    else if (!found.ok) throw new Error(`could not read endpoint ${endpointId}: ${found.status}`);
  }
  if (!endpointId) {
    const byAlias = (await listAll(cfg, creds, "/Endpoint/")).find(e => e.alias === alias);
    if (byAlias && isId(byAlias.endpoint_id)) endpointId = String(byAlias.endpoint_id);
  }

  if (endpointId) {
    const upd = await vobiz(cfg, creds, "POST", `/Endpoint/${endpointId}/`, { password });
    if (!upd.ok) throw new Error(`could not set the endpoint password: ${upd.status}`);
  } else {
    const base = `vobizsf${agentId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 24);
    // app_id travels as a string; bindEndpoint below verifies it took.
    let created = await vobiz(cfg, creds, "POST", "/Endpoint/", { username: base, password, alias, app_id: appId });
    if (created.status === 409) {
      // Taken — by another agent id that reduces to the same letters.
      created = await vobiz(cfg, creds, "POST", "/Endpoint/", { username: `${base}${crypto.randomInt(1000, 9999)}`, password, alias, app_id: appId });
    }
    const id = /"endpoint_id"\s*:\s*"?(\d+)/.exec(created.text || "");
    if (!created.ok || !id) {
      throw new Error(`could not create the endpoint: ${created.status} ${String(created.text || "").slice(0, 200)}`);
    }
    endpointId = id[1];
    log(`created endpoint ${endpointId} for "${agentId}" in ${creds.authId}`);
  }

  const info = await bindEndpoint(cfg, creds, endpointId, appId);
  const username = info.json && info.json.username;
  if (!info.ok || !username) throw new Error(`could not read endpoint ${endpointId} back: ${info.status}`);

  store.map[key] = { endpointId, username };
  saveEndpointStore(cfg);
  return { endpointId, username, password };
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
 *
 * The token is the one of the account the webhook belongs to — found from the
 * SIP user, the dialled number or the room — so each account's webhooks are
 * checked against that account's token.
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

/** The live session for an agent key, if any. */
function sessionByKey(key) {
  const sid = state.sessionByAgent.get(key);
  const s = sid && state.sessions.get(sid);
  return s && s.expires >= Date.now() ? s : null;
}

/** The credentials an account's calls are driven with. Server-side only. */
const accountCreds = authId => state.accounts.get(authId) || null;

/** An account by Auth ID, while at least one of its agents is signed in. */
function accountWithSessions(authId) {
  const account = state.accounts.get(authId);
  if (!account) return null;
  return [...state.sessions.values()].some(s => s.authId === authId && s.expires >= Date.now()) ? account : null;
}

/** The signed-in account that owns a dialled number, matched on digits. */
function accountForNumber(number) {
  const wanted = digitsOnly(number);
  if (!wanted) return null;
  for (const account of state.accounts.values()) {
    if (!account.numbers.some(n => digitsOnly(n) === wanted)) continue;
    const anyoneSignedIn = [...state.sessions.values()].some(s => s.authId === account.authId && s.expires >= Date.now());
    if (anyoneSignedIn) return account;
  }
  return null;
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

function xmlParkInbound(cfg, room) {
  const cb = `${cfg.publicBaseUrl}/conf-event?room=${encodeURIComponent(room)}&role=caller`;
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

function xmlAgentJoinsCaller(cfg, room, record) {
  const cb = `${cfg.publicBaseUrl}/conf-event?room=${encodeURIComponent(room)}&role=agent`;
  return `<Response>
${recordTag(cfg, record)}  <Conference startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="false" timeLimit="3600"
    callbackUrl="${escapeXml(cb)}" callbackMethod="POST">${escapeXml(room)}</Conference>
  <Hangup/>
</Response>`;
}

function xmlAgentWaits(cfg, room, record) {
  const cb = `${cfg.publicBaseUrl}/conf-event?room=${encodeURIComponent(room)}&role=agent`;
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

/**
 * The account's numbers that can carry a call: every page of
 * GET /numbers?page=N&per_page=100, keeping `status === "active"` and
 * `voice_enabled !== false`. Also each number's current application, so
 * "Enable inbound calls" can say which app the number is moving from. The
 * first page doubles as the check that the Auth ID and Token are real.
 */
async function listNumbers(cfg, creds) {
  const numbers = [];
  const numberApps = {};
  let seen = 0;
  for (let page = 1; page <= 50; page++) {
    const r = await vobiz(cfg, creds, "GET", `/numbers?page=${page}&per_page=100`);
    if (!r.ok) return { ok: false, status: r.status };
    const items = (r.json && (r.json.items || r.json.objects)) || [];
    seen += items.length;
    for (const n of items) {
      const e164 = toE164(n.e164 || n.number);
      if (!e164 || n.status !== "active" || n.voice_enabled === false || numbers.includes(e164)) continue;
      numbers.push(e164);
      numberApps[e164] = n.application_id ? String(n.application_id) : null;
    }
    const total = Number(r.json && r.json.total);
    if (items.length === 0 || items.length < 100 || (Number.isFinite(total) && seen >= total)) break;
  }
  return { ok: true, numbers, numberApps };
}

async function handleLogin(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, authId, authToken } = await panelJson(req);
  if (!AGENT_ID.test(String(agentId || ""))) return sendJson(res, 400, { error: "agentId must be 1-40 letters, digits, - or _" });
  if (!authId || !authToken) return sendJson(res, 400, { error: "Enter both an Auth ID and an Auth Token." });

  // Any Vobiz account may sign in: the pair is checked against Vobiz, not
  // against an account this backend was configured for.
  const creds = { authId: String(authId).trim(), authToken: String(authToken).trim() };
  const listed = await listNumbers(cfg, creds).catch(() => ({ ok: false, status: 502 }));
  if (!listed.ok) {
    warn(`login for "${agentId}" refused by Vobiz (${listed.status})`);
    return sendJson(res, 401, { error: "Vobiz rejected that Auth ID and Auth Token. Copy both again from the Vobiz Console dashboard." });
  }
  const { numbers, numberApps } = listed;

  // The token is held in memory, per account, for driving that account's calls.
  state.accounts.set(creds.authId, { ...creds, numbers, numberApps });

  // One live session per (account, agent): signing in again replaces the old one.
  const key = agentKey(creds.authId, agentId);
  const previous = state.sessionByAgent.get(key);
  if (previous) state.sessions.delete(previous);
  const sid = crypto.randomBytes(32).toString("hex");
  const maxAge = Math.round(cfg.sessionHours * 3600);
  state.sessions.set(sid, {
    sid, mode: "account", authId: creds.authId, agentId, key, numbers, numberApps, from: numbers[0] || null, sip: null, expires: Date.now() + maxAge * 1000,
  });
  state.sessionByAgent.set(key, sid);
  log(`"${agentId}" signed in to ${creds.authId} — ${numbers.length} number(s)`);
  sendJson(res, 200, { numbers, numberApps, selected: numbers[0] || null }, { "Set-Cookie": sessionCookie(cfg, sid, maxAge) });
}

/**
 * SIP direct sign-in: the agent typed an existing endpoint's SIP username and
 * password into the panel, and a caller ID. The password never comes here —
 * the panel registers with it directly. The backend only records which caller
 * ID (and so which inbound number) belongs to that SIP user, for routing the
 * webhooks. No account credentials are involved; Vobiz itself refuses a caller
 * ID the endpoint's account does not own.
 */
async function handleSipDirect(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, sipUser, callerId } = await panelJson(req);
  if (!AGENT_ID.test(String(agentId || ""))) return sendJson(res, 400, { error: "agentId must be 1-40 letters, digits, - or _" });
  const user = sipUserOf(String(sipUser || "").trim());
  if (!/^[A-Za-z0-9]{3,64}$/.test(user)) return sendJson(res, 400, { error: "Enter the endpoint's SIP username (letters and digits)." });
  const number = cleanPhone(callerId);
  if (!number) return sendJson(res, 400, { error: "Enter the caller ID in international format, e.g. +<country code><number>." });
  if (state.sipUsers.has(user)) return sendJson(res, 409, { error: "That endpoint is signed in through a Vobiz account already." });

  // One SIP user per inbound number: a second SIP user cannot claim a number
  // someone signed in is already taking calls on.
  for (const [other, entry] of state.sipDirect) {
    const live = state.sessions.get(entry.sid);
    if (other !== user && live && live.expires >= Date.now() && digitsOnly(entry.callerId) === digitsOnly(number)) {
      return sendJson(res, 409, { error: "Another signed-in SIP user is already using that number." });
    }
  }

  const key = `sip:${user}`;
  const previous = state.sessionByAgent.get(key);
  if (previous) state.sessions.delete(previous);
  const sid = crypto.randomBytes(32).toString("hex");
  const maxAge = Math.round(cfg.sessionHours * 3600);
  state.sessions.set(sid, {
    sid, mode: "sip", authId: null, agentId, key, sipUser: user, numbers: [number], from: number, sip: null,
    expires: Date.now() + maxAge * 1000,
  });
  state.sessionByAgent.set(key, sid);
  state.sipDirect.set(user, { sid, callerId: number });
  log(`"${agentId}" signed in SIP direct as ${user}, caller ID ${number}`);
  sendJson(res, 200, { sipUser: user, callerId: number }, { "Set-Cookie": sessionCookie(cfg, sid, maxAge) });
}

/** The live SIP-direct entry for a SIP username, if any. */
function sipDirectFor(user) {
  const entry = state.sipDirect.get(user);
  const s = entry && state.sessions.get(entry.sid);
  return s && s.expires >= Date.now() ? { ...entry, session: s } : null;
}

/** The live SIP-direct user whose caller ID is the dialled number. */
function sipDirectForNumber(number) {
  const wanted = digitsOnly(normalizeDid(number));
  if (!wanted) return null;
  for (const user of state.sipDirect.keys()) {
    const e = sipDirectFor(user);
    if (e && digitsOnly(e.callerId) === wanted) return { user, ...e };
  }
  return null;
}

const ACCOUNT_ONLY = "Sign in with your Vobiz account to use this.";

function handleSession(cfg, req, res, agentId) {
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 200, { loggedIn: false });
  if (s.mode === "sip") return sendJson(res, 200, { loggedIn: true, mode: "sip", sipUser: s.sipUser, from: s.from, numbers: s.numbers });
  sendJson(res, 200, { loggedIn: true, mode: "account", numbers: s.numbers, numberApps: s.numberApps, from: s.from, authId: s.authId });
}

async function handleAgent(cfg, req, res, agentId) {
  const s = sessionFor(req, agentId);
  // Never a SIP password without a session for exactly this agent. Before
  // sign-in the panel is told there is no line yet, which it shows as
  // "Sign in below" rather than as a configuration error.
  if (!s) return sendJson(res, 200, { displayName: agentId, provisioned: false });
  // SIP direct: the panel already has the credentials it typed.
  if (s.mode === "sip") return sendJson(res, 200, { displayName: agentId, provisioned: false, mode: "sip" });
  const account = accountCreds(s.authId);
  if (!account) return sendJson(res, 401, { error: "Sign in again." });
  if (!s.sip) {
    if (!cfg.publicBaseUrl) return sendJson(res, 500, { error: "PUBLIC_BASE_URL is not set on the backend" });
    try {
      const appId = await ensureApplication(cfg, account, "VobizSF", `${cfg.publicBaseUrl}/answer`);
      const ep = await ensureEndpoint(cfg, account, agentId, appId);
      s.sip = { username: ep.username, password: ep.password, endpointId: ep.endpointId };
      state.sipUsers.set(ep.username, s.key);
    } catch (err) {
      warn(`provisioning "${agentId}" in ${s.authId} failed: ${err.message}`);
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
  if (s.mode === "sip") return sendJson(res, 400, { error: ACCOUNT_ONLY });
  if (!s.numbers.includes(number)) return sendJson(res, 400, { error: "That number is not on this account." });
  s.from = number;
  sendJson(res, 200, { selected: number });
}

/**
 * "Enable inbound calls": attach the selected number to this integration's
 * inbound application in the agent's own account. Only ever on this explicit
 * action, because attaching moves the number off whatever app it was on.
 */
async function handleSetupInbound(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { error: "Sign in first — routing a number is an account-level change." });
  if (s.mode === "sip") return sendJson(res, 400, { error: ACCOUNT_ONLY });
  const account = accountCreds(s.authId);
  if (!account) return sendJson(res, 401, { error: "Sign in again." });
  if (!s.from) return sendJson(res, 400, { error: "This account has no number to route." });
  if (!cfg.publicBaseUrl) return sendJson(res, 500, { error: "PUBLIC_BASE_URL is not set on the backend" });
  try {
    const appId = await ensureApplication(cfg, account, "VobizSF_in", `${cfg.publicBaseUrl}/inbound-answer`);
    const previousApplicationId = (s.numberApps && s.numberApps[s.from]) || null;
    const attach = await vobiz(cfg, account, "POST", `/numbers/%2B${digitsOnly(s.from)}/application`, { application_id: appId });
    if (!attach.ok) throw new Error(`attaching ${s.from} returned ${attach.status}`);
    if (s.numberApps) s.numberApps[s.from] = appId;
    log(`inbound calls to ${s.from} now ring ${s.authId}'s signed-in agents (was on ${previousApplicationId || "no application"})`);
    sendJson(res, 200, { number: s.from, applicationId: appId, previousApplicationId });
  } catch (err) {
    warn(`setup-inbound for "${agentId}" in ${s.authId} failed: ${err.message}`);
    sendJson(res, 502, { error: err.message });
  }
}

function handleInboundPending(cfg, req, res, agentId) {
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { pending: false, error: "Sign in first." });
  state.lastPoll.set(s.key, Date.now());
  const p = state.pending.get(s.key);
  if (!p || p.state !== "ringing") return sendJson(res, 200, { pending: false });
  sendJson(res, 200, { pending: true, room: p.room, from: p.from, to: p.to, callUuid: p.callUuid });
}

/** Withdraw an inbound offer from every panel it rang on. */
function clearOffer(offer) {
  if (!offer) return;
  if (offer.timer) clearTimeout(offer.timer);
  offer.timer = null;
  for (const key of offer.offered) if (state.pending.get(key) === offer) state.pending.delete(key);
  offer.offered.clear();
}

async function handleInboundAccept(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  const p = state.pending.get(s.key);
  if (!p || p.state !== "ringing") return sendJson(res, 200, { ok: false, reason: "the call is no longer ringing" });

  // First to accept takes the call; it stops ringing on every other panel.
  // The no-answer timer stops now, before the browser's leg arrives: getting
  // the microphone and gathering ICE take seconds, and a slow join must not
  // race the caller into voicemail.
  clearOffer(p);
  p.state = "accepted";
  p.acceptedBy = s.key;
  // Kept against this agent only, so nothing else rings them until they join.
  p.offered.add(s.key);
  state.pending.set(s.key, p);
  // A backstop in case the browser's leg never arrives at all.
  p.timer = setTimeout(() => {
    if (p.state !== "accepted" || state.joinExpected.get(s.key)?.callUuid !== p.callUuid) return;
    warn(`"${agentId}" accepted ${p.callUuid} but never joined — sending the caller to voicemail`);
    state.joinExpected.delete(s.key);
    clearOffer(p);
    endConference(cfg, accountCreds(p.authId), p.room);
  }, JOIN_WINDOW_MS).unref();
  state.joinExpected.set(s.key, { room: p.room, from: p.from, callUuid: p.callUuid, at: Date.now(), callerGone: false });
  sendJson(res, 200, { ok: true, room: p.room, from: p.from, callUuid: p.callUuid });
}

async function handleInboundDecline(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  const p = state.pending.get(s.key);
  if (p && p.state === "ringing") {
    state.pending.delete(s.key);
    p.offered.delete(s.key);
    // Once every panel it rang on has declined, ending the room drops the
    // caller out of <Conference> and on to voicemail.
    if (p.offered.size === 0) {
      clearOffer(p);
      p.state = "declined";
      await endConference(cfg, accountCreds(p.authId), p.room);
    }
  }
  sendJson(res, 200, { ok: true });
}

async function handleInboundHangup(cfg, req, res) {
  if (!panelPostAllowed(cfg, req)) return sendJson(res, 403, { error: "cross-origin request refused" });
  const { agentId, callUuid } = await panelJson(req);
  const s = sessionFor(req, agentId);
  if (!s) return sendJson(res, 401, { ok: false, reason: "Sign in first." });
  // Only the caller this agent took — never an arbitrary call on the account.
  const offer = callUuid && state.inboundCalls.get(callUuid);
  if (!offer || offer.acceptedBy !== s.key) return sendJson(res, 200, { ok: false, reason: "not your call" });
  state.joinExpected.delete(s.key);
  clearOffer(offer);
  if (offer.timer) clearTimeout(offer.timer);
  state.inboundCalls.delete(callUuid);
  state.inboundRooms.delete(offer.room);
  // A hangup, not ending the room: ending it would play the caller the
  // voicemail greeting after a finished conversation.
  const ok = await hangupCall(cfg, accountCreds(offer.authId), callUuid);
  sendJson(res, 200, { ok });
}

/* ------------------------------------------------------------------ *
 * Webhooks Vobiz calls
 * ------------------------------------------------------------------ */

/**
 * A PSTN caller dialled a number attached to the inbound application. The
 * account is found from the dialled number among signed-in accounts' numbers,
 * and the call rings every signed-in agent of THAT account whose panel is open.
 */
async function handleInboundAnswer(cfg, req, res, url, parsed) {
  const body = parsed || await webhookFields(req, url);
  const callUuid = field(body, "CallUUID");
  const from = field(body, "From");
  const to = field(body, "To");

  if (isHangup(body)) {
    // The caller hung up. A browser leg still on its way must not ring them back.
    const offer = state.inboundCalls.get(callUuid);
    const owner = offer ? accountCreds(offer.authId) : (accountWithSessions(field(body, "ParentAuthID")) || accountForNumber(to));
    if (!webhookAllowed(cfg, req, url, owner)) return sendXml(res, EMPTY);
    if (offer) {
      clearOffer(offer);
      const j = offer.acceptedBy && state.joinExpected.get(offer.acceptedBy);
      if (j && j.callUuid === callUuid) j.callerGone = true;
      if (offer.state !== "accepted") {
        offer.state = "gone";
        state.inboundCalls.delete(callUuid);
        state.inboundRooms.delete(offer.room);
      }
    }
    return sendXml(res, EMPTY);
  }

  // The account is named by ParentAuthID on the webhook; the dialled number is
  // the fallback for a payload without it.
  const parentAuthId = field(body, "ParentAuthID");
  const account = (parentAuthId && accountWithSessions(parentAuthId)) || accountForNumber(to);
  if (!webhookAllowed(cfg, req, url, account)) return sendXml(res, HANGUP);
  if (!account) {
    // A SIP-direct agent taking calls on this number: ring their endpoint.
    const direct = sipDirectForNumber(to);
    if (direct) {
      const did = normalizeDid(to);
      log(`inbound from ${from} to ${did} — ringing SIP direct user ${direct.user}`);
      return sendXml(res, `<Response>
  <Dial callerId="${escapeXml(did)}" timeout="${cfg.inboundRingSeconds}" action="${escapeXml(`${cfg.publicBaseUrl}/dial-status`)}" method="POST" redirect="false">
    <User>${escapeXml(`sip:${direct.user}@registrar.vobiz.ai`)}</User>
  </Dial>
</Response>`);
    }
    log(`inbound from ${from} to ${to}${parentAuthId ? ` (${parentAuthId})` : ""}: nobody signed in for this account or number — hanging up`);
    return sendXml(res, `<Response><Speak>Sorry, this number cannot take calls right now. Please try again later.</Speak><Hangup/></Response>`);
  }

  // Panels of this account that are open and not already ringing.
  const now = Date.now();
  const ringable = [...state.sessions.values()]
    .filter(s => s.authId === account.authId && s.expires >= now && state.sessionByAgent.get(s.key) === s.sid)
    .map(s => s.key)
    .filter(key => now - (state.lastPoll.get(key) || 0) <= PRESENCE_MS && !state.pending.has(key));
  if (ringable.length === 0) {
    // Nobody's panel is open: straight to voicemail, not two minutes of hold music.
    log(`inbound from ${from} to ${to} (${account.authId}) — no free panel listening, voicemail`);
    return sendXml(res, xmlVoicemail());
  }

  const room = roomFor("in", callUuid);
  const offer = {
    room, authId: account.authId, from, to, callUuid, state: "ringing", timer: null,
    offered: new Set(ringable), acceptedBy: null,
  };
  offer.timer = setTimeout(() => {
    if (offer.state !== "ringing") return;
    log(`inbound ${callUuid} to ${to} not answered in ${cfg.inboundRingSeconds}s — voicemail`);
    clearOffer(offer);
    offer.state = "unanswered";
    endConference(cfg, accountCreds(offer.authId), room);
  }, cfg.inboundRingSeconds * 1000).unref();
  for (const key of ringable) state.pending.set(key, offer);
  state.inboundRooms.set(room, offer);
  state.inboundCalls.set(callUuid, offer);
  log(`inbound from ${from} to ${to} parked in ${room}, ringing ${ringable.length} panel(s) of ${account.authId}`);
  sendXml(res, xmlParkInbound(cfg, room));
}

/**
 * The browser placed a call. Who it is comes from the SIP username in From —
 * the endpoint this backend provisioned for one (account, agent) — never from
 * the URL, so one account's agent can never act as, or bill, another account.
 */
async function handleAnswer(cfg, req, res, url) {
  const body = await webhookFields(req, url);
  const callUuid = field(body, "CallUUID");
  const from = field(body, "From");
  const caller = sipUserOf(from);
  const key = state.sipUsers.get(caller);
  const session = key ? sessionByKey(key) : null;
  const account = session ? accountCreds(session.authId) : null;
  const direct = session ? null : sipDirectFor(caller);

  // The hangup notification arrives at this same URL. Answering it with call
  // XML would start a new leg after the call has ended.
  if (isHangup(body)) {
    for (const [room, r] of state.outboundRooms) {
      if (r.agentLeg !== callUuid) continue;
      if (!webhookAllowed(cfg, req, url, accountCreds(r.authId))) break;
      if (!r.answered) { r.closed = true; endConference(cfg, accountCreds(r.authId), room); }
    }
    return sendXml(res, EMPTY);
  }

  if (!webhookAllowed(cfg, req, url, account)) return sendXml(res, HANGUP);

  const browserIsALeg = /^sips?:/i.test(from) || field(body, "RouteType").toLowerCase() === "sip";
  if (!browserIsALeg) {
    // A phone calling a number bound to the same application as the endpoint.
    return handleInboundAnswer(cfg, req, res, url, body);
  }

  const record = ["true", "1", "yes", "on"].includes(vhField(body, "X-VH-Record").trim().toLowerCase());
  const headerCli = cleanPhone(vhField(body, "X-VH-Caller-ID"));

  // SIP direct: no account credentials, so no REST call — the destination is
  // dialled by the XML itself, from the caller ID on the call or the one the
  // agent signed in with. Vobiz refuses one the account does not own.
  if (direct) {
    const to = digitsOnly(field(body, "To").replace(/^sips?:/i, "").split("@")[0]);
    if (to.length < 6 || to.length > 15) {
      return sendXml(res, `<Response><Speak>That number could not be dialled.</Speak><Hangup/></Response>`);
    }
    const callerId = headerCli || direct.callerId;
    log(`SIP direct ${caller}: dialling ${to} from ${callerId}`);
    return sendXml(res, `<Response>
${recordTag(cfg, record)}  <Dial callerId="${escapeXml(callerId)}" timeout="${cfg.outboundRingSeconds}" timeLimit="14400" action="${escapeXml(`${cfg.publicBaseUrl}/dial-status`)}" method="POST" redirect="false">
    <Number>${escapeXml(to)}</Number>
  </Dial>
</Response>`);
  }

  // Only an endpoint this backend handed to a signed-in agent may spend that
  // agent's account. Without this, anyone who can POST to /answer could dial
  // any number on someone's bill.
  if (!session || !account || !session.sip || session.sip.username !== caller) {
    warn(`/answer: call from "${caller}" is not a signed-in agent's endpoint — refused`);
    return sendXml(res, `<Response><Speak>Please sign in to the softphone again.</Speak><Hangup/></Response>`);
  }

  // Is this leg the agent coming to meet a waiting caller? Checked BEFORE the
  // dialled number: the browser dialled the caller's own number to get here,
  // so dialling it now would ring them back.
  const join = state.joinExpected.get(session.key);
  if (join && Date.now() - join.at <= JOIN_WINDOW_MS) {
    state.joinExpected.delete(session.key);
    clearOffer(state.inboundCalls.get(join.callUuid));
    if (join.callerGone) {
      return sendXml(res, `<Response><Speak>That caller has already hung up.</Speak><Hangup/></Response>`);
    }
    log(`"${session.agentId}" (${session.authId}) joining ${join.room} (caller ${join.from})`);
    return sendXml(res, xmlAgentJoinsCaller(cfg, join.room, record));
  }
  if (join) state.joinExpected.delete(session.key);

  // A genuine outbound call: the agent waits in a room, the destination is
  // dialled into it over the REST API, from the number the agent selected —
  // which sign-in and /select-number already checked is on this account.
  const to = digitsOnly(field(body, "To").replace(/^sips?:/i, "").split("@")[0]);
  if (to.length < 6 || to.length > 15) {
    return sendXml(res, `<Response><Speak>That number could not be dialled.</Speak><Hangup/></Response>`);
  }
  // The caller ID sent on the call wins when the account owns it; otherwise the
  // number selected in the panel.
  const callerId = headerCli && session.numbers.includes(headerCli) ? headerCli
    : session.from && session.numbers.includes(session.from) ? session.from : null;
  if (!callerId) {
    return sendXml(res, `<Response><Speak>No caller ID is set for this phone line.</Speak><Hangup/></Response>`);
  }

  const room = roomFor("ob", callUuid);
  if (state.outboundRooms.has(room)) {
    // Vobiz can fetch an answer URL twice for one call; do not dial twice.
    return sendXml(res, xmlAgentWaits(cfg, room, record));
  }
  const r = { authId: session.authId, agentKey: session.key, agentLeg: callUuid, legs: new Set(), answered: false, closed: false, timer: null };
  r.timer = setTimeout(() => {
    if (r.answered || r.closed) return;
    log(`outbound ${room}: ${to} did not answer — ending the room`);
    r.closed = true;
    endConference(cfg, accountCreds(r.authId), room);
  }, (cfg.outboundRingSeconds + 5) * 1000).unref();
  state.outboundRooms.set(room, r);

  // Not awaited: the agent's leg must reach the room before the destination can answer into it.
  vobiz(cfg, account, "POST", "/Call/", {
    from: callerId,
    to,
    answer_url: `${cfg.publicBaseUrl}/outbound-join?room=${encodeURIComponent(room)}`,
    answer_method: "GET",
    hangup_url: `${cfg.publicBaseUrl}/outbound-hangup?room=${encodeURIComponent(room)}`,
    hangup_method: "POST",
    ring_timeout: String(cfg.outboundRingSeconds),
  }).then(result => {
    if (result.ok) { log(`outbound ${room}: dialling ${to} from ${callerId} (${session.authId})`); return; }
    warn(`outbound ${room}: Vobiz refused to dial ${to}: ${result.status} ${JSON.stringify(result.json).slice(0, 200)}`);
    r.closed = true;
    endConference(cfg, accountCreds(r.authId), room);
  }).catch(err => {
    warn(`outbound ${room}: ${err.message}`);
    r.closed = true;
    endConference(cfg, accountCreds(r.authId), room);
  });

  sendXml(res, xmlAgentWaits(cfg, room, record));
}

async function handleOutboundJoin(cfg, req, res, url) {
  const room = url.searchParams.get("room") || "";
  const r = state.outboundRooms.get(room);
  if (!r || !webhookAllowed(cfg, req, url, accountCreds(r.authId))) return sendXml(res, HANGUP);
  // The agent gave up while this phone was ringing: do not seat them in an empty room.
  if (r.closed) return sendXml(res, HANGUP);
  sendXml(res, xmlDestinationJoins(cfg, room));
}

async function handleOutboundHangup(cfg, req, res, url) {
  const room = url.searchParams.get("room") || "";
  const r = state.outboundRooms.get(room);
  if (r && webhookAllowed(cfg, req, url, accountCreds(r.authId)) && !r.answered && !r.closed) {
    // Busy, rejected or unanswered: release the agent rather than leave them waiting.
    log(`outbound ${room}: destination leg ended before answering — releasing the agent`);
    r.closed = true;
    endConference(cfg, accountCreds(r.authId), room);
  }
  sendXml(res, EMPTY);
}

async function handleConfEvent(cfg, req, res, url) {
  const body = await webhookFields(req, url);
  const room = url.searchParams.get("room") || field(body, "ConferenceName");
  const role = url.searchParams.get("role") || "";
  const action = field(body, "ConferenceAction").toLowerCase();
  const leg = field(body, "CallUUID");

  const r = state.outboundRooms.get(room);
  const offer = r ? null : state.inboundRooms.get(room);
  const authId = r ? r.authId : offer ? offer.authId : null;
  if (!webhookAllowed(cfg, req, url, authId ? accountCreds(authId) : null)) return sendXml(res, EMPTY);

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
  } else if (offer && role === "agent" && action === "enter") {
    // Both legs are in the inbound room; the offer is over.
    clearOffer(offer);
    if (offer.acceptedBy && state.pending.get(offer.acceptedBy) === offer) state.pending.delete(offer.acceptedBy);
  } else if (offer && role === "caller" && action === "exit") {
    clearOffer(offer);
    const j = offer.acceptedBy && state.joinExpected.get(offer.acceptedBy);
    if (j && j.room === room) j.callerGone = true;
    state.inboundRooms.delete(room);
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
      if (m === "POST" && p === "/sip-direct") return await handleSipDirect(cfg, req, res);
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
      if (p === "/dial-status") return sendXml(res, EMPTY);
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
