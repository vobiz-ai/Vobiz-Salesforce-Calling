// Drives app/softphone.js through app/opencti-host.js against a fake Open CTI
// toolkit and a fake JsSIP, to check what Salesforce is asked to do and when:
// the screen pop at the start of a call, and the Task at the end of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HOST_SRC = readFileSync(new URL("../app/opencti-host.js", import.meta.url), "utf8");
const PANEL_SRC = readFileSync(new URL("../app/softphone.js", import.meta.url), "utf8");
const tick = () => new Promise(r => setTimeout(r, 0));

function emitter() {
  const handlers = {};
  return {
    on(name, fn) { (handlers[name] ||= []).push(fn); },
    emit(name, arg) { for (const fn of handlers[name] || []) fn(arg); },
    removeAllListeners() {},
  };
}

const SIGNED_IN = {
  "/agent/": { displayName: "Agent One", sipUser: "agentone@registrar.vobiz.ai", sipPassword: "s3cret-pass", provisioned: true },
  "/session/": { loggedIn: true, numbers: ["+910000000001"], from: "+910000000001", authId: "MA_TEST0001" },
};

async function boot({ searchResult = {}, backend = {} } = {}) {
  backend = { ...SIGNED_IN, ...backend };
  const calls = [];
  const sforce = {
    opencti: {
      CALL_TYPE: { INBOUND: "inbound", OUTBOUND: "outbound" },
      SCREENPOP_TYPE: { SOBJECT: "sobject" },
    },
  };
  for (const m of ["enableClickToDial", "setSoftphonePanelVisibility", "screenPop", "searchAndScreenPop", "saveLog"]) {
    sforce.opencti[m] = args => {
      calls.push({ method: m, args });
      const returnValue = m === "searchAndScreenPop" ? searchResult : {};
      args.callback({ success: true, returnValue });
    };
  }
  let clickListener = null;
  sforce.opencti.onClickToDial = ({ listener }) => { clickListener = listener; };

  const sessions = [];
  const ua = emitter();
  ua.start = () => setTimeout(() => ua.emit("registered"), 0);
  ua.stop = () => {};
  ua.call = (target, opts) => {
    const s = emitter();
    s.target = target; s.opts = opts;
    sessions.push(s);
    return s;
  };

  const elements = {};
  const el = id => (elements[id] ||= {
    id, hidden: true, value: "", textContent: "", checked: false, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, appendChild() {},
  });
  const ctx = {
    URL, URLSearchParams, Promise, JSON, Math, Date, Object, String, Boolean, Number, Set, Map, Error,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    console: { error: (...a) => process.env.DEBUG && console.error(...a), warn: (...a) => process.env.DEBUG && console.error(...a), log() {}, info() {}, debug() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sforce,
    JsSIP: { WebSocketInterface: function () {}, UA: function () { return ua; } },
    fetch: async (url, opts) => {
      const path = new URL(url).pathname;
      const key = Object.keys(backend).find(k => path.startsWith(k));
      const value = key ? backend[key] : {};
      const body = typeof value === "function" ? value() : value;
      return { ok: true, status: 200, json: async () => body };
    },
    window: {
      location: { search: "?org=acme.my.salesforce.com&agentId=agent-one", origin: "https://calling.example.com" },
      addEventListener() {},
    },
    document: {
      referrer: "",
      getElementById: el,
      createElement: () => ({}),
      addEventListener() {},
      head: { appendChild: tag => setTimeout(() => tag.onload(), 0) },
    },
  };
  ctx.window.AudioContext = undefined;
  vm.createContext(ctx);
  vm.runInContext(`${HOST_SRC}\n${PANEL_SRC}\n;this.__panel = { placeCall, pollInbound, acceptCall, declineCall, setAuthMode, setSipRegistered: v => { sipRegistered = v; } };`, ctx);
  for (let i = 0; i < 10; i++) await tick();
  /** A call Vobiz delivers straight to the registered endpoint, as <Dial><User> does. */
  const ring = identity => {
    const s = emitter();
    s.remote_identity = identity;
    s.answer = () => {};
    s.terminate = () => s.emit("ended");
    ua.emit("newRTCSession", { originator: "remote", session: s });
    return s;
  };
  return { calls, sessions, panel: ctx.__panel, click: p => clickListener(p), elements, ring, el };
}

const ofMethod = (calls, m) => calls.filter(c => c.method === m);

test("click-to-dial is enabled and its record is used without a second pop", async () => {
  const { calls, sessions, click } = await boot();
  assert.equal(ofMethod(calls, "enableClickToDial").length, 1);
  click({ number: "+910000000099", recordId: "003AAA", objectType: "Contact" });
  await tick();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].target, "sip:+910000000099@registrar.vobiz.ai");
  assert.equal(ofMethod(calls, "searchAndScreenPop").length, 0, "the agent is already on the record");

  sessions[0].emit("confirmed");
  sessions[0].emit("ended");
  for (let i = 0; i < 5; i++) await tick();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.WhoId, "003AAA");
  assert.equal(log.args.value.CallType, "Outbound");
  assert.equal(log.args.value.entityApiName, "Task");
});

test("a dialled number pops its record as the call starts, not when it ends", async () => {
  const { calls, sessions, panel } = await boot({
    searchResult: { "001BBB": { Id: "001BBB", Name: "Acme", RecordType: "Account" } },
  });
  panel.placeCall("+910000000099");
  await tick();
  const pops = ofMethod(calls, "searchAndScreenPop");
  assert.equal(pops.length, 1, "popped before the call ended");
  assert.equal(pops[0].args.callType, "outbound");
  assert.equal(pops[0].args.searchParams, "+910000000099");

  sessions[0].emit("ended");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(ofMethod(calls, "searchAndScreenPop").length, 1, "not popped a second time");
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.WhatId, "001BBB", "an Account belongs in WhatId");
  assert.equal(log.args.value.WhoId, undefined);
  assert.equal(log.args.value.CallDurationInSeconds, 0, "never connected, so zero talk time");
});

test("an inbound caller's record pops while the panel rings", async () => {
  const { calls, sessions, panel } = await boot({
    searchResult: { "003CCC": { Id: "003CCC", Name: "Priya", RecordType: "Contact" } },
    backend: {
      "/inbound-pending/": { pending: true, room: "zhabc", from: "910000000099", callUuid: "uuid-1" },
      "/inbound-accept": { ok: true, room: "zhabc", from: "910000000099", callUuid: "uuid-1" },
    },
  });
  panel.setSipRegistered(true);
  await panel.pollInbound();
  await tick();
  const pops = ofMethod(calls, "searchAndScreenPop");
  assert.equal(pops.length, 1);
  assert.equal(pops[0].args.callType, "inbound");

  await panel.acceptCall();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sessions.length, 1);
  sessions[0].emit("confirmed");
  sessions[0].emit("ended");
  for (let i = 0; i < 5; i++) await tick();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.WhoId, "003CCC");
  assert.equal(log.args.value.CallType, "Inbound");
  assert.equal(ofMethod(calls, "searchAndScreenPop").length, 1);
});

test("several matches pop nothing in particular and relate the Task to nothing", async () => {
  const { calls, sessions, panel } = await boot({
    searchResult: { "003A": { RecordType: "Contact" }, "003B": { RecordType: "Contact" } },
  });
  panel.placeCall("+910000000099");
  sessions[0].emit("ended");
  for (let i = 0; i < 5; i++) await tick();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.WhoId, undefined);
  assert.equal(log.args.value.WhatId, undefined);
});

test("the SIP User-Agent is a single token", () => {
  const ua = /user_agent:\s*"([^"]+)"/.exec(PANEL_SRC);
  assert.ok(ua, "a user_agent is set");
  assert.doesNotMatch(ua[1], /\s/);
});

test("the panel hard-codes no caller ID, phone number or Auth ID", () => {
  const html = readFileSync(new URL("../app/softphone.html", import.meta.url), "utf8");
  for (const src of [PANEL_SRC, html, HOST_SRC]) {
    assert.doesNotMatch(src, /\+?\b\d{2}[ -]?\d{5}[ -]?\d{5}\b/, "a phone number");
    assert.doesNotMatch(src, /MA_(?!X{8})[A-Z0-9]{8}/, "an Auth ID");
  }
});

const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

test("outbound talk time starts when the destination answers, not when the panel's leg connects", async () => {
  let answeredAt = null;
  const { calls, sessions, panel } = await boot({
    backend: { "/call-state/": () => ({ now: Date.now(), outbound: { to: "+910000000099", placedAt: Date.now(), answeredAt, endedAt: null } }) },
  });
  panel.placeCall("+910000000099");
  sessions[0].emit("confirmed"); // in the room; the destination is still ringing
  await settle();
  answeredAt = Date.now() - 3000; // the backend saw the destination answer 3 s ago
  sessions[0].emit("ended");
  await settle();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.CallDurationInSeconds, 3);
  assert.equal(log.args.value.CallDisposition, undefined);
  assert.equal(log.args.value.Subject, "Vobiz call to +910000000099");
});

test("an outbound call the destination never answered logs zero seconds as No answer", async () => {
  const { calls, sessions, panel } = await boot({
    backend: { "/call-state/": () => ({ now: Date.now(), outbound: { to: "+910000000099", placedAt: Date.now(), answeredAt: null, endedAt: Date.now() } }) },
  });
  panel.placeCall("+910000000099");
  sessions[0].emit("confirmed");
  await settle();
  sessions[0].emit("ended");
  await settle();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.CallDurationInSeconds, 0);
  assert.equal(log.args.value.CallDisposition, "No answer");
  assert.match(log.args.value.Subject, /\(no answer\)$/);
});

test("SIP direct inbound: the caller in callerName pops their record and the call is logged", async () => {
  const { calls, panel, ring } = await boot({
    searchResult: { "003DDD": { Id: "003DDD", RecordType: "Contact" } },
  });
  panel.setAuthMode("sip");
  // From user is the dialled DID (the agent's own number); callerName is the caller.
  const s = ring({ display_name: "910000000098", uri: { user: "910000000004" } });
  await settle();
  const pops = ofMethod(calls, "searchAndScreenPop");
  assert.equal(pops.length, 1, "popped while ringing");
  assert.equal(pops[0].args.searchParams, "+910000000098");
  assert.equal(pops[0].args.callType, "inbound");
  await panel.acceptCall();
  s.emit("confirmed");
  s.emit("ended");
  await settle();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.CallType, "Inbound");
  assert.equal(log.args.value.WhoId, "003DDD");
  assert.equal(log.args.value.Subject, "Vobiz call from +910000000098");
});

test("SIP direct inbound: with no display name the caller comes from the backend, not the agent's own DID", async () => {
  const { calls, panel, ring, el } = await boot({
    backend: { "/call-state/": () => ({ now: Date.now(), outbound: null, directInbound: { from: "+910000000097", to: "+910000000004", at: Date.now() } }) },
  });
  panel.setAuthMode("sip");
  el("sip-caller-id").value = "+910000000004";
  const s = ring({ display_name: "", uri: { user: "910000000004" } });
  await settle();
  const [pop] = ofMethod(calls, "searchAndScreenPop");
  assert.equal(pop.args.searchParams, "+910000000097");
  assert.equal(el("incoming-from").textContent, "+910000000097");
  s.emit("failed"); // the caller gave up
  await settle();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.CallDisposition, "Missed");
  assert.equal(log.args.value.CallDurationInSeconds, 0);
  assert.match(log.args.value.Subject, /from \+910000000097 \(missed\)$/);
});

test("SIP direct inbound: declining is logged as declined", async () => {
  const { calls, panel, ring } = await boot();
  panel.setAuthMode("sip");
  ring({ display_name: "910000000098", uri: { user: "910000000004" } });
  await settle();
  await panel.declineCall();
  await settle();
  const [log] = ofMethod(calls, "saveLog");
  assert.equal(log.args.value.CallDisposition, "Declined");
});

test("the panel never tells agents the destination is dialled before their browser", () => {
  const html = readFileSync(new URL("../app/softphone.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /dials the customer first|bridges your browser in/i);
  assert.match(html, /browser places the call first/i);
});
