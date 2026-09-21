#!/usr/bin/env node
/**
 * Checks the two things that silently rot in a docs-heavy repository: a
 * relative link that points at nothing, and a heading anchor that has been
 * renamed out from under a link. Both have happened here — docs/backend-contract.md
 * linked to an ISSUES.md that did not exist.
 *
 * Exits non-zero on the first kind of failure, because a broken install link in
 * a public repository costs someone an afternoon.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: a repository checked out under a path with a
// space in it gets %20 back from .pathname and every readdir fails.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/** GitHub's slug rules, near enough: lowercase, drop punctuation, spaces to dashes. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(file) {
  const set = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  return set;
}

const failures = [];
const anchorCache = new Map();

for (const file of markdownFiles(ROOT)) {
  const body = readFileSync(file, "utf8");
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;

    const [path, anchor] = target.split("#");
    const resolved = normalize(join(dirname(file), path));
    if (!existsSync(resolved)) {
      failures.push(`${relative(ROOT, file)} -> ${target} (no such file)`);
      continue;
    }
    if (anchor && resolved.endsWith(".md")) {
      if (!anchorCache.has(resolved)) anchorCache.set(resolved, anchorsOf(resolved));
      if (!anchorCache.get(resolved).has(anchor)) {
        failures.push(`${relative(ROOT, file)} -> ${target} (no such heading)`);
      }
    }
  }
}

if (failures.length) {
  console.error("Broken documentation links:\n" + failures.map(f => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log("Documentation links resolve.");
