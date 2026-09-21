/**
 * Regenerate app/softphone.js from the Freshsales panel.
 *
 * Mechanical and re-runnable on purpose. The telephony in that panel — the
 * conference bridge, the ICE gathering cap, the placeholder-password gate, the
 * caller release on hangup — is the part that took longest to get right, and it
 * should stay one implementation rather than several that drift. Only the CRM
 * write-back differs per platform, so only that is replaced here.
 *
 * Usage:
 *   node tools/port-from-freshsales.mjs <path-to-Vobiz-Freshsales-Calling>
 *
 * Or set FRESHSALES_REPO in the environment. Review the diff before committing:
 * this rewrites a file by matching on comment text, and a large refactor
 * upstream can move the anchors.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const freshsales = process.argv[2] || process.env.FRESHSALES_REPO;
if (!freshsales) {
  console.error("usage: node tools/port-from-freshsales.mjs <path-to-Vobiz-Freshsales-Calling>");
  process.exit(1);
}

const SRC = join(freshsales, "app", "scripts", "app.js");
const OUT = join(REPO, "app", "softphone.js");

if (!existsSync(SRC)) {
  console.error(`✖ not found: ${SRC}`);
  console.error("  Pass the path to a Vobiz-Freshsales-Calling checkout.");
  process.exit(1);
}

const src = readFileSync(SRC, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const L = src.split(/\r?\n/);

// The CRM block runs from findContact's doc comment to the one before
// tryInterface. Everything between is Freshworks-specific and gets replaced.
const start = L.findIndex(l => l.includes("* The contact this number belongs to"));
const tryIdx = L.findIndex(l => l.includes("* Ask the host to do something"));
if (start < 0 || tryIdx < 0) {
  console.error("✖ could not find the CRM block. The upstream panel has moved;");
  console.error("  update the anchors in this script rather than editing softphone.js by hand.");
  process.exit(1);
}

const replacement = `/**
 * The Salesforce record this number belongs to, or null when nobody matches.
 *
 * searchAndScreenPop does the lookup and the screen pop in one call, which is
 * how Open CTI expects a softphone to behave: the agent lands on the record
 * while the call is still connecting rather than after it. A miss is not an
 * error — plenty of calls are to people who are not in the CRM.
 */
async function findContact(number, inbound) {
  const phone = e164(number);
  if (!phone) return null;
  try {
    const found = await openCti("searchAndScreenPop", {
      searchParams: phone,
      callType: inbound ? sforce.opencti.CALL_TYPE.INBOUND : sforce.opencti.CALL_TYPE.OUTBOUND,
      deferred: false,
    });
    // Keyed by record id, with the object type inside each entry. One match
    // pops automatically; several leave the agent to choose, and the panel
    // should not guess on their behalf.
    const ids = Object.keys(found || {});
    if (ids.length !== 1) return null;
    return { id: ids[0], type: (found[ids[0]] || {}).RecordType || "Contact" };
  } catch (err) {
    console.warn("[Vobiz] contact lookup failed:", err && err.message);
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
 */
async function logCallToCrm({ number, inbound, durationSec, recordingUrl }) {
  const contact = await findContact(number, inbound);

  const lines = [\`Vobiz call \${inbound ? "from" : "to"} \${e164(number)}\`];
  // The recording is a link rather than an attachment: saveLog writes fields,
  // not files, and a clickable URL on the activity is the most that reaches the
  // agent without a second API and a stored OAuth token.
  if (recordingUrl) lines.push(\`Recording: \${recordingUrl}\`);

  try {
    await openCti("saveLog", {
      value: {
        entityApiName: "Task",
        Subject: \`Vobiz call \${inbound ? "from" : "to"} \${e164(number)}\`,
        CallType: inbound ? "Inbound" : "Outbound",
        CallDurationInSeconds: Math.max(0, Math.round(durationSec || 0)),
        Description: lines.join(" · "),
        Status: "Completed",
        ActivityDate: new Date().toISOString().slice(0, 10),
        // Left unset when nothing matched, which files the call without a
        // related record rather than dropping it.
        ...(contact ? { WhoId: contact.id } : {}),
      },
    });
    console.info("[Vobiz] logged the call" + (contact ? \` against \${contact.id}\` : " with no matching record"));
    return contact ? contact.id : null;
  } catch (err) {
    console.warn("[Vobiz] could not write the call log:", err && err.message);
    return null;
  }
}
`;

let text = [...L.slice(0, start - 1), ...replacement.split("\n"), ...L.slice(tryIdx - 1)].join(eol);

// The call sites travel with the rename.
text = text.split("logCallToFreshsales(").join("logCallToCrm(");

text = `/** === Vobiz Calling — Salesforce Open CTI softphone ===
 *
 * GENERATED from the Freshsales panel by tools/port-from-freshsales.mjs.
 *
 * The telephony is identical on purpose — the conference bridge, the ICE
 * gathering cap, the placeholder-password gate and the caller release on hangup
 * are not CRM-specific and should not be reimplemented per platform. Only the
 * CRM write-back below differs, and app/opencti-host.js supplies the host
 * object this file expects.
 *
 * Fix telephony in the Freshsales panel and re-run the port. Fix Salesforce
 * behaviour in opencti-host.js or in the CRM functions, and mirror it into this
 * script so the next port does not undo it.
 */
` + text;

writeFileSync(OUT, text, "utf8");
console.log(`✔ wrote ${OUT}`);
console.log(`  ${text.split(/\r?\n/).length} lines — review the diff before committing`);
