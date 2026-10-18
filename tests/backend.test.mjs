// The reference backend, driven end to end against a fake Vobiz REST API that
// knows two accounts: sign-in and provisioning for any account, both call
// directions as Vobiz would drive them, and the requests an attacker would
// try. No real account is touched; every id and number here is a fake.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const backend = require("../backend/server.js");

const A = "MA_TEST0001";
const B = "MA_TEST0002";
const ACCOUNTS = {
  [A]: { token: "test-token-account-one", numbers: ["+910000000001", "+910000000002"], outApp: "43919358318796814", inApp: "43919358318796815" },
  [B]: { token: "test-token-account-two", numbers: ["+910000000003"], outApp: "43919358318796900", inApp: "43919358318796901" },
};
const TOKENS = Object.values(ACCOUNTS).map(a => a.token);
const DEST = "+910000000099";

let vobiz, vobizUrl, server, base, apiCalls, fake, dataDir;

function listen(srv) {
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
}

/** Fresh per-test state of the fake Vobiz: applications and endpoints per account. */
function freshFake() {
  const out = {};
  for (const id of Object.keys(ACCOUNTS)) {
    out[id] = {
      apps: [], endpoints: new Map(),
      numbers: [
        ...ACCOUNTS[id].numbers.map((n, i) => ({ e164: n.slice(1), status: "active", voice_enabled: true, application_id: i === 0 ? "43919358318700777" : null })),
        { e164: "910000000050", status: "inactive", voice_enabled: true },
        { e164: "910000000051", status: "active", voice_enabled: false },
      ],
    };
  }
  // ignoreAppId: behave as if Vobiz silently ignored {"app_id": ...} on an endpoint.
  return { accounts: out, nextEndpoint: 70001, ignoreAppId: false };
}

before(async () => {
  vobiz = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const authId = req.headers["x-auth-id"];
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      apiCalls.push({ method: req.method, path: url.pathname, query: url.search, raw, body, authId });
      // Raw text, so ids can be sent as bare 17-digit integers the way a
      // careless API would — the backend must not lose a digit.
      const send = (status, text) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(text); };
      const json = (status, obj) => send(status, JSON.stringify(obj));
      const acct = ACCOUNTS[authId];
      if (!acct || req.headers["x-auth-token"] !== acct.token) return json(401, { error: "auth" });
      const prefix = `/api/v1/Account/${authId}`;
      if (!url.pathname.startsWith(prefix)) return json(403, { error: "wrong account in path" });
      const p = url.pathname.slice(prefix.length);
      const st = fake.accounts[authId];

      if (req.method === "GET" && p === "/numbers") {
        const page = Number(url.searchParams.get("page") || 1);
        const per = Number(url.searchParams.get("per_page") || 20);
        const all = st.numbers;
        return json(200, { items: all.slice((page - 1) * per, page * per), page, per_page: per, total: all.length });
      }
      if (req.method === "GET" && p === "/Application/") {
        const objs = st.apps.map(a => `{"app_id":${a.app_id},"app_name":"${a.app_name}","answer_url":"${a.answer_url}"}`);
        return send(200, `{"meta":{"total_count":${objs.length}},"objects":[${objs.join(",")}]}`);
      }
      if (req.method === "POST" && p === "/Application/") {
        const app_id = body.answer_url.endsWith("/inbound-answer") ? acct.inApp : acct.outApp;
        st.apps.push({ app_id, app_name: body.app_name, answer_url: body.answer_url });
        return send(201, `{"message":"created","app_id":${app_id}}`);
      }
      if (req.method === "POST" && /^\/Application\/\d+\/$/.test(p)) return json(202, {});
      if (req.method === "GET" && p === "/Endpoint/") {
        return json(200, { objects: [...st.endpoints.values()].map(e => ({ endpoint_id: e.endpoint_id, username: e.username, alias: e.alias })) });
      }
      if (req.method === "POST" && p === "/Endpoint/") {
        // Vobiz rewrites the requested username.
        const endpoint_id = String(fake.nextEndpoint++);
        const e = {
          endpoint_id, username: `${body.username}${endpoint_id}`, alias: body.alias, password: body.password,
          application: !fake.ignoreAppId && body.app_id ? String(body.app_id) : null,
        };
        st.endpoints.set(endpoint_id, e);
        return json(201, { message: "created", endpoint_id, sip_uri: `sip:${e.username}@registrar.vobiz.ai` });
      }
      const ep = /^\/Endpoint\/(\d+)\/$/.exec(p);
      if (ep) {
        const e = st.endpoints.get(ep[1]);
        if (!e) return json(404, { error: "Endpoint not found" });
        if (req.method === "GET") {
          const app = e.application ? `{"app_id":${e.application},"app_name":"x"}` : "null";
          return send(200, `{"endpoint_id":"${e.endpoint_id}","username":"${e.username}","alias":"${e.alias}","application":${app}}`);
        }
        if (req.method === "POST") {
          const bound = /"application"\s*:\s*(\d+)/.exec(raw);
          if (bound) e.application = bound[1];
          const byAppId = /"app_id"\s*:\s*"(\d+)"/.exec(raw);
          if (byAppId && !fake.ignoreAppId) e.application = byAppId[1];
          if (body && body.password) e.password = body.password;
          res.writeHead(202); return res.end();
        }
      }
      if (req.method === "POST" && p.startsWith("/numbers/")) return json(200, { message: "ok" });
      if (req.method === "POST" && p === "/Call/") return json(201, { request_uuid: "req-1" });
      if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
      json(404, { error: "unmocked" });
    });
  });
  vobizUrl = await listen(vobiz);
});

after(() => {
  vobiz.close();
  server && server.close();
});

beforeEach(async () => {
  apiCalls = [];
  fake = freshFake();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-sf-test-"));
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
  dataDir,
  requireSignature: false,
  inboundRingSeconds: 45,
  outboundRingSeconds: 45,
  ...over,
});

const settle = () => new Promise(r => setTimeout(r, 30));

/** No HTTP response from the backend may ever carry an account's Auth Token. */
function assertNoToken(text, headers) {
  const all = text + JSON.stringify([...(headers ? headers.entries() : [])]);
  for (const t of TOKENS) assert.equal(all.includes(t), false, "an Auth Token reached an HTTP response");
}

async function panel(urlPath, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assertNoToken(text, res.headers);
  let json = null;
  try { json = JSON.parse(text); } catch { /* xml or text */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A Vobiz webhook: form-encoded POST, optionally signed. */
async function webhook(urlPath, fields, { sign = null } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (sign) {
    const nonce = "12345678901234567890";
    const baseUrl = `${base}${urlPath.split("?")[0]}`;
    headers["X-Vobiz-Signature-V3"] = crypto.createHmac("sha256", sign).update(`${baseUrl}.${nonce}`).digest("base64");
    headers["X-Vobiz-Signature-V3-Nonce"] = nonce;
  }
  const res = await fetch(`${base}${urlPath}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
  const text = await res.text();
  assertNoToken(text, res.headers);
  return text;
}

async function signIn(agentId = "agent-one", authId = A) {
  const res = await panel("/login", { method: "POST", body: { agentId, authId, authToken: ACCOUNTS[authId].token } });
  assert.equal(res.status, 200, res.text);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const agent = await panel(`/agent/${agentId}`, { cookie });
  assert.equal(agent.status, 200, agent.text);
  return { cookie, agent: agent.json, login: res };
}

const callsTo = (suffix, method = "POST") => apiCalls.filter(c => c.method === method && c.path.endsWith(suffix));

/* ------------------------------------------------------------------ *
 * Sign-in and provisioning
 * ------------------------------------------------------------------ */

test("sign-in sets an HttpOnly, partitioned session cookie and lists the numbers", async () => {
  const { login, agent } = await signIn();
  assert.deepEqual(login.json.numbers, ["+910000000001", "+910000000002"]);
  assert.equal(login.json.selected, "+910000000001");
  const setCookie = login.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"]) assert.match(setCookie, new RegExp(attr));
  assert.equal(agent.sipUser, "vobizsfagentone70001@registrar.vobiz.ai", "the username Vobiz stored, not the one asked for");
  assert.equal(agent.provisioned, true);
  assert.ok(apiCalls.some(c => c.method === "GET" && c.path === `/api/v1/Account/${A}/numbers` && c.query.includes("page=1&per_page=100")));
});

test("provisioning: one application per account, found by answer URL; endpoint bound with the exact 17-digit app id", async () => {
  await signIn();
  const [app] = callsTo("/Application/");
  assert.equal(app.body.answer_url, `${base}/answer`);
  assert.equal(app.body.answer_method, "POST");
  assert.equal(app.body.hangup_url, `${base}/answer`);
  assert.equal(app.body.hangup_method, "POST");

  const [create] = callsTo("/Endpoint/");
  assert.match(create.body.username, /^[A-Za-z0-9]+$/);
  assert.match(create.raw, /"app_id":"43919358318796814"/, "the app id travels as an exact string");
  assert.equal(create.body.application, undefined, "never as a JSON number");

  const binds = apiCalls.filter(c => c.method === "POST" && /\/Endpoint\/\d+\/$/.test(c.path) && /app_id|application/.test(c.raw));
  assert.deepEqual(binds.map(b => b.raw), ['{"app_id":"43919358318796814"}'], "bound first time, so no fallback");
  assert.ok(apiCalls.some(c => c.method === "GET" && c.path.endsWith("/Endpoint/70001/")), "the bind is read back");
  assert.equal(fake.accounts[A].endpoints.get("70001").application, "43919358318796814");
  assert.equal(apiCalls.some(c => c.path.includes("/numbers/") && c.method === "POST"), false, "no number is attached at sign-in");
});

test("provisioning: if app_id does not take, the documented integer application carries all 17 digits", async () => {
  fake.ignoreAppId = true;
  await signIn();
  const binds = apiCalls.filter(c => c.method === "POST" && /\/Endpoint\/\d+\/$/.test(c.path) && /app_id|application/.test(c.raw));
  assert.deepEqual(binds.map(b => b.raw), ['{"app_id":"43919358318796814"}', '{"application":43919358318796814}']);
  assert.equal(fake.accounts[A].endpoints.get("70001").application, "43919358318796814");
});

test("numbers: every page is read, and only active, voice-enabled numbers are offered", async () => {
  for (let i = 0; i < 120; i++) fake.accounts[A].numbers.push({ e164: `91000000${String(1000 + i)}`, status: "active", voice_enabled: true });
  const { login } = await signIn();
  assert.equal(login.json.numbers.length, 122);
  assert.ok(!login.json.numbers.includes("+910000000050"), "inactive");
  assert.ok(!login.json.numbers.includes("+910000000051"), "voice disabled");
  assert.equal(login.json.numberApps["+910000000001"], "43919358318700777", "the app each number is on now");
  const pages = apiCalls.filter(c => c.method === "GET" && c.path.endsWith("/numbers")).map(c => new URLSearchParams(c.query).get("page"));
  assert.deepEqual(pages, ["1", "2"]);
});

test("provisioning: the endpoint map is 0600 and holds no password or token", async () => {
  const { agent } = await signIn();
  const file = path.join(dataDir, "endpoints.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(stored, { [`${A}:agent-one`]: { endpointId: "70001", username: "vobizsfagentone70001" } });
  const text = fs.readFileSync(file, "utf8");
  for (const t of TOKENS) assert.equal(text.includes(t), false);
  assert.equal(text.includes(agent.sipPassword), false);
});

test("signing in again reuses the endpoint and application, with a fresh password", async () => {
  const first = await signIn();
  const second = await signIn();
  assert.equal(callsTo("/Endpoint/").length, 1, "created once");
  assert.equal(callsTo("/Application/").length, 1, "created once");
  assert.equal(second.agent.sipUser, first.agent.sipUser);
  assert.notEqual(second.agent.sipPassword, first.agent.sipPassword);
  assert.equal(fake.accounts[A].endpoints.get("70001").password, second.agent.sipPassword);
});

test("a lost endpoint map is recovered by alias rather than creating a second endpoint", async () => {
  await signIn();
  fs.rmSync(path.join(dataDir, "endpoints.json"));
  backend.resetState();
  await signIn();
  assert.equal(callsTo("/Endpoint/").length, 1);
});

test("an application someone else owns is never touched", async () => {
  fake.accounts[A].apps.push({ app_id: "43919358318700001", app_name: "VobizSF", answer_url: "https://someone-else.example/answer" });
  await signIn();
  assert.equal(apiCalls.some(c => c.path.includes("/Application/43919358318700001/")), false);
  assert.equal(callsTo("/Application/").length, 1, "its own app was created instead");
});

test("an application this integration already created is reused, not duplicated", async () => {
  fake.accounts[A].apps.push({ app_id: ACCOUNTS[A].outApp, app_name: "VobizSF", answer_url: `${base}/answer` });
  await signIn();
  assert.equal(callsTo("/Application/").length, 0);
  assert.equal(fake.accounts[A].endpoints.get("70001").application, ACCOUNTS[A].outApp);
});

test("a wrong Auth Token is refused", async () => {
  const res = await panel("/login", { method: "POST", body: { agentId: "a", authId: A, authToken: "wrong" } });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /rejected/);
  assert.equal(res.headers.get("set-cookie"), null);
  const other = await panel("/login", { method: "POST", body: { agentId: "a", authId: A, authToken: ACCOUNTS[B].token } });
  assert.equal(other.status, 401, "one account's token does not open another");
});

test("two different accounts sign in at once, with the same agent id, and get distinct endpoints", async () => {
  const one = await signIn("agent-one", A);
  const two = await signIn("agent-one", B);
  assert.notEqual(one.agent.sipUser, two.agent.sipUser);
  assert.notEqual(one.cookie, two.cookie);
  assert.equal(fake.accounts[A].endpoints.size, 1);
  assert.equal(fake.accounts[B].endpoints.size, 1);
  assert.equal([...fake.accounts[B].endpoints.values()][0].application, ACCOUNTS[B].outApp);
  // Each session still sees its own account.
  assert.equal((await panel("/session/agent-one", { cookie: one.cookie })).json.authId, A);
  assert.equal((await panel("/session/agent-one", { cookie: two.cookie })).json.authId, B);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "endpoints.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), [`${A}:agent-one`, `${B}:agent-one`]);
});

test("no SIP password, session or call control without the agent's own session", async () => {
  const { cookie } = await signIn("agent-one");
  for (const [p, opts, why] of [["/agent/agent-one", {}, "no cookie"], ["/agent/agent-two", { cookie }, "another agent's id"]]) {
    const res = await panel(p, opts);
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
    body: JSON.stringify({ agentId: "agent-one", number: "+910000000002" }),
  });
  assert.equal(textPlain.status, 403, "a simple (no-preflight) request is refused");
  const foreign = await panel("/select-number", {
    method: "POST", cookie, headers: { Origin: "https://evil.example" }, body: { agentId: "agent-one", number: "+910000000002" },
  });
  assert.equal(foreign.status, 403);
  const own = await panel("/select-number", { method: "POST", cookie, body: { agentId: "agent-one", number: "+910000000002" } });
  assert.deepEqual(own.json, { selected: "+910000000002" });
  const otherAccounts = await panel("/select-number", { method: "POST", cookie, body: { agentId: "agent-one", number: "+910000000003" } });
  assert.equal(otherAccounts.status, 400, "another account's number cannot be selected");
});

test("no endpoint answers with a wildcard CORS header", async () => {
  const res = await panel("/session/agent-one", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

/* ------------------------------------------------------------------ *
 * Outbound
 * ------------------------------------------------------------------ */

test("outbound: the agent waits in a room and the destination is dialled into it", async () => {
  const { cookie, agent } = await signIn();
  await panel("/select-number", { method: "POST", cookie, body: { agentId: "agent-one", number: "+910000000002" } });
  const xml = await webhook("/answer", {
    CallUUID: "aaaa-1111", From: `sip:${agent.sipUser}`, To: `sip:${DEST}@registrar.vobiz.ai`, "X-VH-Record": "true",
  });
  assert.match(xml, /<Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"/);
  assert.match(xml, />obaaaa1111<\/Conference>/);
  assert.ok(xml.indexOf("<Record") < xml.indexOf("<Conference"), "Record is a sibling before Conference");
  await settle();
  const [dial] = callsTo("/Call/");
  assert.equal(dial.authId, A);
  assert.equal(dial.body.to, DEST.slice(1));
  assert.equal(dial.body.from, "+910000000002", "the number the agent selected");
  assert.equal(dial.body.answer_url, `${base}/outbound-join?room=obaaaa1111`);

  const join = await (await fetch(`${base}/outbound-join?room=obaaaa1111`)).text();
  assert.match(join, /startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="true"/);

  // A repeat fetch of the answer URL must not dial a second time.
  await webhook("/answer", { CallUUID: "aaaa-1111", From: `sip:${agent.sipUser}`, To: DEST });
  await settle();
  assert.equal(callsTo("/Call/").length, 1);
});

test("outbound: a caller ID on the call is used only if the account owns it", async () => {
  const { agent } = await signIn();
  await webhook("/answer", { CallUUID: "bbbb", From: `sip:${agent.sipUser}`, To: DEST, "X-VH-Caller-ID": "+15550100" });
  await webhook("/answer", { CallUUID: "bbb2", From: `sip:${agent.sipUser}`, To: DEST, "SIPHeader_X-VH-Caller-ID": "+910000000002" });
  await webhook("/answer", { CallUUID: "bbb3", From: `sip:${agent.sipUser}`, To: DEST, "X-VH-Caller-ID": "+910000000003" });
  await settle();
  assert.deepEqual(callsTo("/Call/").map(c => c.body.from), ["+910000000001", "+910000000002", "+910000000001"],
    "unowned and another account's numbers fall back to the selected one");
});

test("outbound: each account's browser calls are placed on that account, from its own number", async () => {
  const one = await signIn("agent-one", A);
  const two = await signIn("agent-one", B);
  await webhook("/answer", { CallUUID: "acct-a", From: `sip:${one.agent.sipUser}`, To: DEST });
  await webhook("/answer", { CallUUID: "acct-b", From: `sip:${two.agent.sipUser}`, To: DEST });
  await settle();
  const dials = callsTo("/Call/");
  assert.equal(dials.length, 2);
  const byAccount = Object.fromEntries(dials.map(d => [d.authId, d.body.from]));
  assert.deepEqual(byAccount, { [A]: "+910000000001", [B]: "+910000000003" });
});

test("outbound: an unanswered destination releases the agent", async () => {
  const { agent } = await signIn();
  await webhook("/answer", { CallUUID: "cccc", From: `sip:${agent.sipUser}`, To: DEST });
  await webhook("/outbound-hangup?room=obcccc", { CallUUID: "dest-1", HangupCause: "NO_ANSWER" });
  await settle();
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path.endsWith("/Conference/obcccc/")));
  const late = await (await fetch(`${base}/outbound-join?room=obcccc`)).text();
  assert.match(late, /<Hangup\/>/);
  assert.doesNotMatch(late, /<Conference/);
});

test("call state: talk time starts when the destination answers, not when the agent's leg connects", async () => {
  const { cookie, agent } = await signIn();
  assert.equal((await panel("/call-state/agent-one")).status, 401, "needs the agent's session");
  await webhook("/answer", { CallUUID: "tt-1", From: `sip:${agent.sipUser}`, To: DEST });
  // The agent's leg is in the room: connected, but nobody has answered.
  await webhook("/conf-event?room=obtt1&role=agent", { ConferenceAction: "enter", CallUUID: "tt-1" });
  let st = (await panel("/call-state/agent-one", { cookie })).json;
  assert.equal(typeof st.now, "number");
  assert.equal(st.outbound.to, DEST);
  assert.equal(typeof st.outbound.placedAt, "number");
  assert.equal(st.outbound.answeredAt, null);

  await fetch(`${base}/outbound-join?room=obtt1`);
  st = (await panel("/call-state/agent-one", { cookie })).json;
  assert.ok(st.outbound.answeredAt >= st.outbound.placedAt, "answered when the destination's answer URL was fetched");
  const answeredAt = st.outbound.answeredAt;
  await webhook("/conf-event?room=obtt1&role=destination", { ConferenceAction: "enter", CallUUID: "dest-tt" });
  await webhook("/conf-event?room=obtt1&role=destination", { ConferenceAction: "exit", CallUUID: "dest-tt" });
  await webhook("/conf-event?room=obtt1&role=agent", { ConferenceAction: "exit", CallUUID: "tt-1" });
  st = (await panel("/call-state/agent-one", { cookie })).json;
  assert.equal(st.outbound.answeredAt, answeredAt, "the first answer signal wins");
  assert.equal(typeof st.outbound.endedAt, "number");
});

test("call state: an unanswered destination is never marked answered", async () => {
  const { cookie, agent } = await signIn();
  await webhook("/answer", { CallUUID: "na-1", From: `sip:${agent.sipUser}`, To: DEST });
  await webhook("/outbound-hangup?room=obna1", { CallUUID: "dest-na", HangupCause: "NO_ANSWER" });
  await fetch(`${base}/outbound-join?room=obna1`);
  const st = (await panel("/call-state/agent-one", { cookie })).json;
  assert.equal(st.outbound.answeredAt, null);
  assert.equal(typeof st.outbound.endedAt, "number");
});

test("call state: polling it is not presence, so an agent on a call is not rung", async () => {
  const { cookie } = await signIn();
  await panel("/setup-inbound", { method: "POST", cookie, body: { agentId: "agent-one" } });
  await panel("/call-state/agent-one", { cookie });
  const xml = await webhook("/inbound-answer", { CallUUID: "busy-1", From: "910000000098", To: "910000000001", ParentAuthID: A });
  assert.match(xml, /leave a message/);
});

test("toll fraud: a forged /answer cannot dial out", async () => {
  await signIn();
  for (const from of ["sip:someone-else@registrar.vobiz.ai", "+910000000098"]) {
    const xml = await webhook("/answer", { CallUUID: "evil", From: from, To: "+447700900000" });
    assert.match(xml, /<Hangup\/>/);
    assert.doesNotMatch(xml, /<Conference/);
  }
  // The old ?agentId= query names nobody: identity comes from the SIP user.
  const named = await webhook("/answer?agentId=agent-one", { CallUUID: "evil2", From: "sip:x@registrar.vobiz.ai", To: "+447700900000" });
  assert.match(named, /<Hangup\/>/);
  await settle();
  assert.equal(callsTo("/Call/").length, 0);
});

test("webhook signatures are checked with the token of the account the call belongs to", async () => {
  const one = await signIn("agent-one", A);
  await signIn("agent-one", B);
  const good = await webhook("/answer", { CallUUID: "sig-1", From: `sip:${one.agent.sipUser}`, To: DEST }, { sign: ACCOUNTS[A].token });
  assert.match(good, /<Conference/);
  const otherAccount = await webhook("/answer", { CallUUID: "sig-2", From: `sip:${one.agent.sipUser}`, To: DEST }, { sign: ACCOUNTS[B].token });
  assert.equal(otherAccount.includes("<Conference"), false, "signed with another account's token");
  const forged = await webhook("/answer", { CallUUID: "sig-3", From: `sip:${one.agent.sipUser}`, To: DEST }, { sign: "not-the-token" });
  assert.equal(forged.includes("<Conference"), false);
});

test("the hangup notification gets an empty response, never call XML", async () => {
  const { agent } = await signIn();
  const xml = await webhook("/answer", { CallUUID: "h1", From: `sip:${agent.sipUser}`, To: DEST, Event: "Hangup" });
  assert.match(xml, /<Response><\/Response>/);
});

/* ------------------------------------------------------------------ *
 * Inbound
 * ------------------------------------------------------------------ */

test("inbound: enable, park, offer, accept, join, hang up", async () => {
  const { cookie, agent } = await signIn();
  const setup = await panel("/setup-inbound", { method: "POST", cookie, body: { agentId: "agent-one", platform: "salesforce" } });
  assert.equal(setup.json.number, "+910000000001");
  const inApp = callsTo("/Application/").find(c => c.body.answer_url === `${base}/inbound-answer`);
  assert.ok(inApp, "the inbound application points at /inbound-answer");
  const attach = apiCalls.find(c => c.path.includes("/numbers/") && c.method === "POST");
  assert.equal(attach.path, `/api/v1/Account/${A}/numbers/%2B910000000001/application`);
  assert.equal(attach.raw, `{"application_id":"${ACCOUNTS[A].inApp}"}`, "the 17-digit id, exact, as a string");

  await panel("/inbound-pending/agent-one", { cookie }); // the panel is open
  const park = await webhook("/inbound-answer", { CallUUID: "in-1", From: "910000000098", To: "910000000001" });
  assert.match(park, /<Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"/);
  assert.match(park, /<Speak>Sorry, nobody is available/, "voicemail follows the room");

  const offer = await panel("/inbound-pending/agent-one", { cookie });
  assert.deepEqual(offer.json, { pending: true, room: "inin1", from: "910000000098", to: "910000000001", callUuid: "in-1" });

  const accept = await panel("/inbound-accept", { method: "POST", cookie, body: { agentId: "agent-one" } });
  assert.equal(accept.json.ok, true);

  // The browser dials the caller's number; the backend joins it to the room instead.
  const join = await webhook("/answer", { CallUUID: "agent-leg", From: `sip:${agent.sipUser}`, To: "+910000000098" });
  assert.match(join, /startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="false"/);
  assert.match(join, />inin1<\/Conference>/);
  await settle();
  assert.equal(callsTo("/Call/").length, 0, "the caller is never rung back");

  // The next browser call is an ordinary outbound call again.
  const next = await webhook("/answer", { CallUUID: "next", From: `sip:${agent.sipUser}`, To: DEST });
  assert.match(next, />obnext<\/Conference>/);

  assert.equal(setup.json.previousApplicationId, "43919358318700777", "says which app the number moved off");
  const hangup = await panel("/inbound-hangup", { method: "POST", cookie, body: { agentId: "agent-one", callUuid: "in-1" } });
  assert.equal(hangup.json.ok, true);
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path === `/api/v1/Account/${A}/Call/in-1/`));
});

test("inbound: a call is routed to the account that owns the dialled number, and only its agents ring", async () => {
  const one = await signIn("agent-one", A);
  const two = await signIn("agent-one", B);
  await panel("/inbound-pending/agent-one", { cookie: one.cookie });
  await panel("/inbound-pending/agent-one", { cookie: two.cookie });

  await webhook("/inbound-answer", { CallUUID: "to-b", From: "910000000098", To: "+910000000003" });
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: one.cookie })).json.pending, false, "account one's agent does not ring");
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: two.cookie })).json.pending, true);

  // Declined by account two's only agent: the room is ended with account two's credentials.
  await panel("/inbound-decline", { method: "POST", cookie: two.cookie, body: { agentId: "agent-one" } });
  const del = apiCalls.find(c => c.method === "DELETE" && c.path.endsWith("/Conference/intob/"));
  assert.equal(del.authId, B);

  // Account one's agent cannot hang up account two's caller.
  const hang = await panel("/inbound-hangup", { method: "POST", cookie: one.cookie, body: { agentId: "agent-one", callUuid: "to-b" } });
  assert.equal(hang.json.ok, false);
});

test("inbound: a number no signed-in account owns gets a polite hangup", async () => {
  const { cookie } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  const xml = await webhook("/inbound-answer", { CallUUID: "stray", From: "910000000098", To: "+910000000077" });
  assert.match(xml, /<Speak>Sorry, this number cannot take calls/);
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<Conference/);
});

test("inbound: every open panel of the account rings, and the first to accept takes it", async () => {
  const one = await signIn("agent-one", A);
  const two = await signIn("agent-two", A);
  await panel("/inbound-pending/agent-one", { cookie: one.cookie });
  await panel("/inbound-pending/agent-two", { cookie: two.cookie });
  await webhook("/inbound-answer", { CallUUID: "both", From: "910000000098", To: "910000000002" });
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: one.cookie })).json.pending, true);
  assert.equal((await panel("/inbound-pending/agent-two", { cookie: two.cookie })).json.pending, true);

  assert.equal((await panel("/inbound-accept", { method: "POST", cookie: two.cookie, body: { agentId: "agent-two" } })).json.ok, true);
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: one.cookie })).json.pending, false, "stops ringing elsewhere");
  const late = await panel("/inbound-accept", { method: "POST", cookie: one.cookie, body: { agentId: "agent-one" } });
  assert.equal(late.json.ok, false);
});

test("inbound: a webhook signed with another account's token is refused", async () => {
  const { cookie } = await signIn("agent-one", A);
  await signIn("agent-one", B);
  await panel("/inbound-pending/agent-one", { cookie });
  const xml = await webhook("/inbound-answer", { CallUUID: "sig-in", From: "910000000098", To: "910000000001" }, { sign: ACCOUNTS[B].token });
  assert.doesNotMatch(xml, /<Conference/);
  const ok = await webhook("/inbound-answer", { CallUUID: "sig-in2", From: "910000000098", To: "910000000001" }, { sign: ACCOUNTS[A].token });
  assert.match(ok, /<Conference/);
});

test("inbound: an agent cannot hang up a call that was not offered to them", async () => {
  const { cookie } = await signIn();
  const res = await panel("/inbound-hangup", { method: "POST", cookie, body: { agentId: "agent-one", callUuid: "someone-elses-call" } });
  assert.equal(res.json.ok, false);
  assert.equal(apiCalls.filter(c => c.method === "DELETE").length, 0);
});

test("inbound: with no panel open the caller goes straight to voicemail", async () => {
  await signIn();
  const xml = await webhook("/inbound-answer", { CallUUID: "in-2", From: "910000000098", To: "910000000001" });
  assert.doesNotMatch(xml, /<Conference/);
  assert.match(xml, /<Record/);
});

test("inbound: decline ends the room so the caller reaches voicemail", async () => {
  const { cookie } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  await webhook("/inbound-answer", { CallUUID: "in-3", From: "910000000098", To: "910000000001" });
  await panel("/inbound-decline", { method: "POST", cookie, body: { agentId: "agent-one" } });
  assert.ok(apiCalls.some(c => c.method === "DELETE" && c.path.endsWith("/Conference/inin3/")));
  assert.deepEqual((await panel("/inbound-pending/agent-one", { cookie })).json, { pending: false });
});

test("inbound: a caller who hangs up after Accept is not rung back", async () => {
  const { cookie, agent } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  await webhook("/inbound-answer", { CallUUID: "in-4", From: "910000000098", To: "910000000001" });
  await panel("/inbound-accept", { method: "POST", cookie, body: { agentId: "agent-one" } });
  await webhook("/inbound-answer", { CallUUID: "in-4", To: "910000000001", Event: "Hangup" });
  const join = await webhook("/answer", { CallUUID: "late-leg", From: `sip:${agent.sipUser}`, To: "+910000000098" });
  assert.match(join, /already hung up/);
  await settle();
  assert.equal(callsTo("/Call/").length, 0);
});

test("inbound: ParentAuthID names the account, ahead of the dialled number", async () => {
  const one = await signIn("agent-one", A);
  const two = await signIn("agent-one", B);
  await panel("/inbound-pending/agent-one", { cookie: one.cookie });
  await panel("/inbound-pending/agent-one", { cookie: two.cookie });
  // A number the backend has not listed, but ParentAuthID says account two.
  await webhook("/inbound-answer", { CallUUID: "pa-1", From: "910000000098", To: "910000000060", Direction: "inbound", ParentAuthID: B });
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: two.cookie })).json.pending, true);
  assert.equal((await panel("/inbound-pending/agent-one", { cookie: one.cookie })).json.pending, false);
});

test("inbound: a phone call reaching /answer (number on the same app as the endpoint) is routed as inbound", async () => {
  const { cookie } = await signIn();
  await panel("/inbound-pending/agent-one", { cookie });
  const xml = await webhook("/answer", { CallUUID: "same-app", From: "910000000098", To: "910000000001", Direction: "inbound", ParentAuthID: A });
  assert.match(xml, />insameapp<\/Conference>/);
  await settle();
  assert.equal(callsTo("/Call/").length, 0);
});

/* ------------------------------------------------------------------ *
 * SIP direct: an existing endpoint's SIP username and password, typed into
 * the panel, plus a caller ID. No account credentials anywhere.
 * ------------------------------------------------------------------ */

async function sipDirect(agentId = "desk", sipUser = "deskphone01", callerId = "+910000000004") {
  const res = await panel("/sip-direct", { method: "POST", body: { agentId, sipUser, callerId } });
  return { res, cookie: res.headers.get("set-cookie") && res.headers.get("set-cookie").split(";")[0] };
}

test("SIP direct: sign-in needs no account, validates the caller ID, and hides account features", async () => {
  assert.equal((await sipDirect("desk", "deskphone01", "12345")).res.status, 400, "not E.164");
  assert.equal((await sipDirect("desk", "bad user!", "+910000000004")).res.status, 400);
  const { res, cookie } = await sipDirect();
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { sipUser: "deskphone01", callerId: "+910000000004" });
  assert.equal(apiCalls.length, 0, "no Vobiz API call at all");
  assert.equal((await panel("/agent/desk", { cookie })).json.provisioned, false);
  assert.equal((await panel("/session/desk", { cookie })).json.mode, "sip");
  const inbound = await panel("/setup-inbound", { method: "POST", cookie, body: { agentId: "desk" } });
  assert.equal(inbound.status, 400);
  assert.match(inbound.json.error, /Sign in with your Vobiz account/);
  assert.equal((await panel("/select-number", { method: "POST", cookie, body: { agentId: "desk", number: "+910000000004" } })).status, 400);
});

test("SIP direct: outbound is dialled by XML from the typed caller ID, or the one on the call", async () => {
  await sipDirect();
  const xml = await webhook("/answer", { CallUUID: "sd-1", From: "sip:deskphone01@registrar.vobiz.ai", To: `sip:${DEST}@registrar.vobiz.ai`, "X-VH-Record": "true" });
  assert.match(xml, /<Dial callerId="\+910000000004"/);
  assert.match(xml, /<Number>910000000099<\/Number>/);
  assert.ok(xml.indexOf("<Record") < xml.indexOf("<Dial"), "Record is a sibling before Dial");
  const hdr = await webhook("/answer", { CallUUID: "sd-2", From: "sip:deskphone01@registrar.vobiz.ai", To: DEST, "SIPHeader_X-VH-Caller-ID": "+910000000005" });
  assert.match(hdr, /<Dial callerId="\+910000000005"/);
  const junk = await webhook("/answer", { CallUUID: "sd-3", From: "sip:deskphone01@registrar.vobiz.ai", To: DEST, "X-VH-Caller-ID": "not-a-number" });
  assert.match(junk, /<Dial callerId="\+910000000004"/);
  assert.equal(apiCalls.length, 0, "no REST call: there are no credentials to make one with");
});

test("SIP direct: a call to the typed caller ID rings that endpoint", async () => {
  await sipDirect();
  const xml = await webhook("/inbound-answer", { CallUUID: "sd-in", From: "910000000098", To: "910000000009", Direction: "inbound" });
  assert.match(xml, /cannot take calls/, "a number nobody signed in with");
  const ring = await webhook("/answer", { CallUUID: "sd-in2", From: "910000000098", To: "910000000004", Direction: "inbound", ParentAuthID: "MA_TEST0009" });
  assert.match(ring, /<Dial callerId="\+910000000004"/);
  assert.match(ring, /<User>sip:deskphone01@registrar.vobiz.ai<\/User>/);
});

test("SIP direct: the real caller reaches the panel as callerName and through /call-state", async () => {
  const { cookie } = await sipDirect();
  const xml = await webhook("/inbound-answer", { CallUUID: "sd-cn", From: "+910000000098", To: "910000000004", Direction: "inbound" });
  assert.match(xml, /<Dial callerId="\+910000000004" callerName="910000000098"/, "callerId stays the DID; the caller is the name");
  const st = (await panel("/call-state/desk", { cookie })).json;
  assert.equal(st.directInbound.from, "+910000000098");
  assert.equal(st.directInbound.to, "+910000000004");
});

test("SIP direct: outbound talk time starts at DialAnswer", async () => {
  const { cookie } = await sipDirect();
  const xml = await webhook("/answer", { CallUUID: "sd-tt", From: "sip:deskphone01@registrar.vobiz.ai", To: `sip:${DEST}@registrar.vobiz.ai` });
  assert.match(xml, new RegExp(`callbackUrl="${base.replace(/[.]/g, "\\.")}/dial-event\\?leg=sd-tt"`));
  let st = (await panel("/call-state/desk", { cookie })).json;
  assert.equal(st.outbound.answeredAt, null, "the browser's leg is answered by the XML; the destination is not");
  await webhook("/dial-event?leg=sd-tt", { Event: "DialAnswer", DialAction: "answer", CallUUID: "sd-tt", DialBLegUUID: "b-1" });
  st = (await panel("/call-state/desk", { cookie })).json;
  assert.equal(typeof st.outbound.answeredAt, "number");
  await webhook("/dial-status", { CallUUID: "sd-tt", DialStatus: "completed" });
  st = (await panel("/call-state/desk", { cookie })).json;
  assert.equal(typeof st.outbound.endedAt, "number");
});

test("SIP direct: an 11-digit 0-prefixed DID is normalised to +91 for the Dial caller ID", async () => {
  await sipDirect("desk", "deskphone01", "+910000000004");
  const xml = await webhook("/inbound-answer", { CallUUID: "sd-0", From: "910000000098", To: "00000000004" });
  assert.match(xml, /<Dial callerId="\+910000000004"/);
});

test("SIP direct: a second SIP user cannot claim a number already in use", async () => {
  await sipDirect("desk", "deskphone01", "+910000000004");
  const second = await sipDirect("other", "deskphone02", "+910000000004");
  assert.equal(second.res.status, 409);
});

/* ------------------------------------------------------------------ *
 * Recordings, and the panel's own files
 * ------------------------------------------------------------------ */

test("recordings are never served by the backend, so no link can cross accounts", async () => {
  await signIn();
  for (const p of ["/recordings", "/recordings/agent-one", "/recording?id=x", "/recording-audio/x"]) {
    const res = await panel(p);
    assert.equal(res.status, 404, p);
  }
});

test("the panel is served with a Salesforce-only frame-ancestors policy, and nothing else is", async () => {
  const res = await fetch(`${base}/salesforce/softphone.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors https:\/\/\*\.lightning\.force\.com/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  for (const p of ["/salesforce/../backend/server.js", "/salesforce/%2e%2e/backend/.env", "/salesforce/lib/../../backend/server.js", "/salesforce/", "/salesforce/data/endpoints.json"]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, p);
  }
});
