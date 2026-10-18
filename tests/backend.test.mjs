// The reference backend, driven end to end against a fake Vobiz REST API:
// sign-in and provisioning, both call directions as Vobiz would drive them,
// and the requests an attacker would try. No real account is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const backend = require("../backend/server.js");

const AUTH_ID = "MA_TEST0001";
const AUTH_TOKEN = "test-auth-token";
const NUMBER = "+917900000001";

let vobiz, vobizUrl, server, base, apiCalls;

function listen(srv) {
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
}

before(async () => {
  vobiz = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      apiCalls.push({ method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null });
      const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers["x-auth-id"] !== AUTH_ID || req.headers["x-auth-token"] !== AUTH_TOKEN) return json(401, { error: "auth" });
      const p = url.pathname.replace(`/api/v1/Account/${AUTH_ID}`, "");
      if (req.method === "GET" && p === "/numbers") return json(200, { items: [{ e164: NUMBER }, { e164: "+917900000002" }] });
      if (req.method === "GET" && p === "/Application/") return json(200, { objects: [] });
      if (req.method === "POST" && p === "/Application/") return json(201, { app_id: "11112222333344445" });
      if (req.method === "GET" && p === "/Endpoint/") return json(200, { objects: [] });
      if (req.method === "POST" && p === "/Endpoint/") return json(201, { username: "vobizsfagentone8812345", endpoint_id: "99" });
      if (req.method === "POST" && p.startsWith("/numbers/")) return json(200, { ok: true });
      if (req.method === "POST" && p === "/Call/") return json(201, { request_uuid: "req-1" });
      if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
      json(404, { error: "unmocked" });
    });
  });
  vobizUrl = await listen(vobiz);
});

after(() => { vobiz.close(); server && server.close(); });

beforeEach(async () => {
  apiCalls = [];
  backend.resetState();
  if (server) server.close();
  // Bound first so the public base URL can name the real port.
  server = backend.createServer({ ...cfg(), publicBaseUrl: "PENDING" });
  base = await listen(server);
  server.close();
  server = backend.createServer(cfg());
  await new Promise(r => server.listen(Number(new URL(base).port), "127.0.0.1", r));
});

const cfg = (over = {}) => ({
  ...backend.config(),
  port: 0,
  publicBaseUrl: base || "http://127.0.0.1:1",
  apiBase: vobizUrl,
  accountAuthId: "",
  accountAuthToken: "",
  sipDirectUsers: new Set(),
  requireSignature: false,
  inboundRingSeconds: 45,
  outboundRingSeconds: 45,
  ...over,
});

const settle = () => new Promise(r => setTimeout(r, 30));

async function panel(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* xml or text */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A Vobiz webhook: form-encoded POST, optionally signed. */
async function webhook(path, fields, { sign = null } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (sign) {
    const nonce = "12345678901234567890";
    const baseUrl = `${base}${path.split("?")[0]}`;
    headers["X-Vobiz-Signature-V3"] = crypto.createHmac("sha256", sign).update(`${baseUrl}.${nonce}`).digest("base64");
    headers["X-Vobiz-Signature-V3-Nonce"] = nonce;
  }
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
  return res.text();
}

async function signIn(agentId = "agent-one") {
  const res = await panel("/login", { method: "POST", body: { agentId, authId: AUTH_ID, authToken: AUTH_TOKEN } });
  assert.equal(res.status, 200, res.text);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const agent = await panel(`/agent/${agentId}`, { cookie });
  assert.equal(agent.status, 200, agent.text);
  return { cookie, agent: agent.json, login: res };
}

test("sign-in sets an HttpOnly, partitioned session cookie and lists the numbers", async () => {
  const { login, agent } = await signIn();
  assert.deepEqual(login.json, { numbers: [NUMBER, "+917900000002"], selected: NUMBER });
  const setCookie = login.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"]) assert.match(setCookie, new RegExp(attr));
  assert.doesNotMatch(JSON.stringify(login.json), /test-auth-token/, "the Auth Token is never echoed");

  assert.equal(agent.sipUser, "vobizsfagentone8812345@registrar.vobiz.ai", "the username Vobiz stored, not the one asked for");
  assert.equal(agent.provisioned, true);
  const app = apiCalls.find(c => c.method === "POST" && c.path.endsWith("/Application/"));
  assert.equal(app.body.answer_url, `${base}/answer?agentId=agent-one`);
  const ep = apiCalls.find(c => c.method === "POST" && c.path.endsWith("/Endpoint/"));
  assert.equal(ep.body.application, 11112222333344445);
  assert.match(ep.body.username, /^[A-Za-z0-9]+$/);
});

test("a wrong Auth Token is refused", async () => {
  const res = await panel("/login", { method: "POST", body: { agentId: "a", authId: AUTH_ID, authToken: "wrong" } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("no SIP password, session or call control without the agent's own session", async () => {
  const { cookie } = await signIn("agent-one");
  for (const [path, opts, why] of [["/agent/agent-one", {}, "no cookie"], ["/agent/agent-two", { cookie }, "another agent's id"]]) {
    const res = await panel(path, opts);
    assert.equal(res.json.provisioned, false, why);
    assert.equal(res.json.sipPassword, undefined, why);
  }
  assert.deepEqual((await panel("/session/agent-one")).json, { loggedIn: false });
  assert.equal((await panel("/inbound-pending/agent-one")).status, 401);
  assert.equal((await panel("/setup-inbound", { method: "POST", body: { agentId: "agent-one" } })).status, 401);
});

test("cross-site requests cannot ride the session cookie", async () => {
  const { cookie } = await signIn();
  const textPlain = await fetch(`${base}/select-number`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain" },
    body: JSON.stringify({ agentId: "agent-one", number: "+917900000002" }),
  });
  assert.equal(textPlain.status, 403, "a simple (no-preflight) request is refused");
  const foreign = await panel("/select-number", {
    method: "POST", cookie, headers: { Origin: "https://evil.example" }, body: { agentId: "agent-one", number: "+917900000002" },
  });
  assert.equal(foreign.status, 403);
  const own = await panel("/select-number", { method: "POST", cookie, body: { agentId: "agent-one", number: "+917900000002" } });
  assert.deepEqual(own.json, { selected: "+917900000002" });
  const notOwned = await panel("/select-number", { method: "POST", cookie, body: { agentId: "agent-one", number: "+15550000000" } });
  assert.equal(notOwned.status, 400);
});

test("no endpoint answers with a wildcard CORS header", async () => {
  const res = await panel("/session/agent-one", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("outbound: the agent waits in a room and the destination is dialled into it", async () => {
  const { agent } = await signIn();
  const xml = await webhook("/answer?agentId=agent-one", {
    CallUUID: "aaaa-1111", From: `sip:${agent.sipUser}`, To: "sip:+919876543210@registrar.vobiz.ai",
    "X-VH-Record": "true", "X-VH-Caller-ID": "+917900000002",
  });
  assert.match(xml, /<Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"/);
  assert.match(xml, />obaaaa1111<\/Conference>/);
  assert.ok(xml.indexOf("<Record") < xml.indexOf("<Conference"), "Record is a sibling before Conference");
  await settle();
  const dial = apiCalls.find(c => c.method === "POST" && c.path.endsWith("/Call/"));
  assert.equal(dial.body.to, "919876543210");
  assert.equal(dial.body.from, "+917900000002", "the caller ID the agent chose, since the account owns it");
  assert.equal(dial.body.answer_url, `${base}/outbound-join?room=obaaaa1111`);

  const join = await (await fetch(`${base}/outbound-join?room=obaaaa1111`)).text();
  assert.match(join, /startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="true"/);

  // A repeat fetch of the answer URL must not dial a second time.
  await webhook("/answer?agentId=agent-one", { CallUUID: "aaaa-1111", From: `sip:${agent.sipUser}`, To: "+919876543210" });
  await settle();
  assert.equal(apiCalls.filter(c => c.path.endsWith("/Call/")).length, 1);
});

test("outbound: a caller ID the account does not own falls back to the selected number", async () => {
  const { agent } = await signIn();
  await webhook("/answer?agentId=agent-one", {
    CallUUID: "bbbb", From: `sip:${agent.sipUser}`, To: "+919876543210", "X-VH-Caller-ID": "+15550001111",
  });
  await settle();
  assert.equal(apiCalls.find(c => c.path.endsWith("/Call/")).body.from, NUMBER);
});

test("outbound: an unanswered destination releases the agent", async () => {
  const { agent } = await signIn();
  await webhook("/answer?agentId=agent-one", { CallUUID: "cccc", From: `sip:${agent.sipUser}`, To: "+919876543210" });
  await webhook("/outbound-hangup?room=obcccc", { CallUUID: "dest-1", HangupCause: "NO_ANSWER" });
  await settle();
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path.endsWith("/Conference/obcccc/")));
  const late = await (await fetch(`${base}/outbound-join?room=obcccc`)).text();
  assert.match(late, /<Hangup\/>/);
  assert.doesNotMatch(late, /<Conference/);
});

test("toll fraud: a forged /answer cannot dial out", async () => {
  await signIn();
  for (const from of ["sip:someone-else@registrar.vobiz.ai", "+919999999999"]) {
    const xml = await webhook("/answer?agentId=agent-one", { CallUUID: "evil", From: from, To: "+447700900000" });
    assert.match(xml, /<Hangup\/>/);
    assert.doesNotMatch(xml, /<Conference/);
  }
  const unknownAgent = await webhook("/answer?agentId=nobody", { CallUUID: "evil2", From: "sip:x@registrar.vobiz.ai", To: "+447700900000" });
  assert.match(unknownAgent, /<Hangup\/>/);
  const sipDirect = await webhook("/answer", { CallUUID: "evil3", From: "sip:x@registrar.vobiz.ai", To: "+447700900000" });
  assert.match(sipDirect, /<Hangup\/>/);
  await settle();
  assert.equal(apiCalls.filter(c => c.path.endsWith("/Call/")).length, 0);
});

test("webhook signatures: a valid one passes, a forged one is refused", async () => {
  const { agent } = await signIn();
  const good = await webhook("/answer?agentId=agent-one",
    { CallUUID: "sig-1", From: `sip:${agent.sipUser}`, To: "+919876543210" }, { sign: AUTH_TOKEN });
  assert.match(good, /<Conference/);
  const forged = await webhook("/answer?agentId=agent-one",
    { CallUUID: "sig-2", From: `sip:${agent.sipUser}`, To: "+919876543210" }, { sign: "not-the-token" });
  assert.equal(forged.includes("<Conference"), false);
});

test("the hangup notification gets an empty response, never call XML", async () => {
  const { agent } = await signIn();
  const xml = await webhook("/answer?agentId=agent-one", { CallUUID: "h1", From: `sip:${agent.sipUser}`, To: "+919876543210", Event: "Hangup" });
  assert.match(xml, /<Response><\/Response>/);
});

test("inbound: park, offer, accept, join, hang up", async () => {
  const { cookie, agent } = await signIn();
  const setup = await panel("/setup-inbound", { method: "POST", cookie, body: { agentId: "agent-one", platform: "salesforce" } });
  assert.deepEqual(setup.json, { number: NUMBER });
  const attach = apiCalls.find(c => c.path.includes("/numbers/") && c.method === "POST");
  assert.equal(attach.path, `/api/v1/Account/${AUTH_ID}/numbers/%2B917900000001/application`);
  assert.equal(attach.body.application_id, "11112222333344445");

  await panel("/inbound-pending/agent-one", { cookie }); // the panel is open
  const park = await webhook("/inbound-answer?agentId=agent-one", { CallUUID: "in-1", From: "919876543210", To: "917900000001" });
  assert.match(park, /<Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"/);
  assert.match(park, /<Speak>Sorry, nobody is available/, "voicemail follows the room");

  const offer = await panel("/inbound-pending/agent-one", { cookie });
  assert.deepEqual(offer.json, { pending: true, room: "inin1", from: "919876543210", to: "917900000001", callUuid: "in-1" });

  const accept = await panel("/inbound-accept", { method: "POST", cookie, body: { agentId: "agent-one" } });
  assert.equal(accept.json.ok, true);

  // The browser dials the caller's number; the backend joins it to the room instead.
  const join = await webhook("/answer?agentId=agent-one", { CallUUID: "agent-leg", From: `sip:${agent.sipUser}`, To: "+919876543210" });
  assert.match(join, /startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="false"/);
  assert.match(join, />inin1<\/Conference>/);
  await settle();
  assert.equal(apiCalls.filter(c => c.path.endsWith("/Call/")).length, 0, "the caller is never rung back");

  // The next browser call is an ordinary outbound call again.
  const next = await webhook("/answer?agentId=agent-one", { CallUUID: "next", From: `sip:${agent.sipUser}`, To: "+919876543210" });
  assert.match(next, />obnext<\/Conference>/);

  const hangup = await panel("/inbound-hangup", { method: "POST", cookie, body: { agentId: "agent-one", callUuid: "in-1" } });
  assert.equal(hangup.json.ok, true);
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path.endsWith("/Call/in-1/")));
});

test("inbound: an agent cannot hang up a call that was not offered to them", async () => {
  const { cookie } = await signIn();
  const res = await panel("/inbound-hangup", { method: "POST", cookie, body: { agentId: "agent-one", callUuid: "someone-elses-call" } });
  assert.equal(res.json.ok, false);
  assert.equal(apiCalls.filter(c => c.method === "DELETE").length, 0);
});

test("inbound: with no panel open the caller goes straight to voicemail", async () => {
  await signIn();
  const xml = await webhook("/inbound-answer?agentId=agent-one", { CallUUID: "in-2", From: "919876543210", To: "917900000001" });
  assert.doesNotMatch(xml, /<Conference/);
  assert.match(xml, /<Record/);
});

test("inbound: decline ends the room so the caller reaches voicemail", async () => {
  const { cookie } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  await webhook("/inbound-answer?agentId=agent-one", { CallUUID: "in-3", From: "919876543210", To: "917900000001" });
  await panel("/inbound-decline", { method: "POST", cookie, body: { agentId: "agent-one" } });
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path.endsWith("/Conference/inin3/")));
  assert.deepEqual((await panel("/inbound-pending/agent-one", { cookie })).json, { pending: false });
});

test("inbound: a caller who hangs up after Accept is not rung back", async () => {
  const { cookie, agent } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  await webhook("/inbound-answer?agentId=agent-one", { CallUUID: "in-4", From: "919876543210", To: "917900000001" });
  await panel("/inbound-accept", { method: "POST", cookie, body: { agentId: "agent-one" } });
  await webhook("/inbound-answer?agentId=agent-one", { CallUUID: "in-4", Event: "Hangup" });
  const join = await webhook("/answer?agentId=agent-one", { CallUUID: "late-leg", From: `sip:${agent.sipUser}`, To: "+919876543210" });
  assert.match(join, /already hung up/);
  await settle();
  assert.equal(apiCalls.filter(c => c.path.endsWith("/Call/")).length, 0);
});

test("the panel is served with a Salesforce-only frame-ancestors policy, and nothing else is", async () => {
  const res = await fetch(`${base}/salesforce/softphone.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors https:\/\/\*\.lightning\.force\.com/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  for (const p of ["/salesforce/../backend/server.js", "/salesforce/%2e%2e/backend/.env", "/salesforce/lib/../../backend/server.js", "/salesforce/"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, p);
  }
});
