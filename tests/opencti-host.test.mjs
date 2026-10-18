// The adapter URL's query string is attacker-controlled: anyone can send an
// agent a link to the panel. These tests load app/opencti-host.js in a sandbox
// and check what each hostile parameter actually resolves to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../app/opencti-host.js", import.meta.url), "utf8");
const PANEL = "https://calling.example.com";

async function load(query, { framedBy = null } = {}) {
  let toolkit = null;
  const window = { location: { search: `?${query}`, origin: PANEL } };
  if (framedBy) { window.top = {}; window.self = window; }
  const ctx = {
    URL, URLSearchParams, Promise,
    console: { error() {}, warn() {}, log() {} },
    window,
    document: {
      referrer: framedBy || "",
      createElement: () => ({}),
      head: { appendChild: tag => { toolkit = tag.src; } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\n;this.__host = HOST; this.__ready = TOOLKIT_READY;`, ctx);
  ctx.__ready.catch(() => {});
  const iparams = await ctx.__host.iparams.get();
  return { toolkit, iparams };
}

const TOOLKIT = "https://acme.my.salesforce.com/support/api/64.0/lightning/opencti_min.js";

test("a Salesforce org loads its own toolkit", async () => {
  assert.equal((await load("org=https://acme.my.salesforce.com")).toolkit, TOOLKIT);
  assert.equal((await load("org=acme.my.salesforce.com")).toolkit, TOOLKIT);
});

test("?org= refuses every non-Salesforce host", async () => {
  for (const org of [
    "https://evil.example",
    "https://acme.my.salesforce.com@evil.example",
    "//evil.example",
    "https://my.salesforce.com.evil.example",
    "javascript:alert(1)",
  ]) {
    assert.equal((await load(`org=${encodeURIComponent(org)}`)).toolkit, null, org);
  }
});

test("?apiVersion= cannot walk out of the toolkit path", async () => {
  for (const v of ["../../../resource/1/evil.js?", "x/../../../../sfc/p/evil#", "64.0/../../x", "64"]) {
    const { toolkit } = await load(`org=acme.my.salesforce.com&apiVersion=${encodeURIComponent(v)}`);
    assert.equal(toolkit, null, v);
  }
  const { toolkit } = await load("org=acme.my.salesforce.com&apiVersion=62.0");
  assert.equal(toolkit, "https://acme.my.salesforce.com/support/api/62.0/lightning/opencti_min.js");
});

test("?backendUrl= is not a parameter: the backend is always the panel's own origin", async () => {
  for (const framedBy of [null, "https://acme.lightning.force.com/"]) {
    for (const url of ["https://evil.example", "https://api.acme.example", `${PANEL}/other`]) {
      const { iparams } = await load(`org=acme.my.salesforce.com&backendUrl=${encodeURIComponent(url)}`, { framedBy });
      assert.equal(iparams.backend_url, PANEL, `${url} framed by ${framedBy}`);
    }
  }
});

test("?registrarUrl= must be a Vobiz wss:// registrar", async () => {
  assert.equal((await load("registrarUrl=wss://evil.example")).iparams.registrar_url, "wss://registrar.vobiz.ai:5063/");
  assert.equal((await load("registrarUrl=wss://registrar.vobiz.ai.evil.example")).iparams.registrar_url, "wss://registrar.vobiz.ai:5063/");
  assert.equal((await load("registrarUrl=wss://registrar.vobiz.ai:5063/")).iparams.registrar_url, "wss://registrar.vobiz.ai:5063/");
});
