#!/usr/bin/env node
/**
 * DD-338 Phase D.5 — marketplace tile state refresh wrapper.
 *
 * Thin orchestrator around the existing `scripts/build-catalog.js`. Chains:
 *
 *   1. Snapshot existing dist/catalog.json → dist/catalog.json.prev (if any)
 *   2. Run `node scripts/build-catalog.js` (regenerates dist/catalog.json
 *      + per-pack manifests + services.json + add-ons.json)
 *   3. Diff prev vs new catalog (per-tool granularity declaration flips +
 *      per-entry tier/readiness changes + add/remove counts)
 *   4. Write dist/dd-338-refresh-summary.json (structured)
 *   5. Print brief human-readable summary to stdout
 *
 * On first run (no prior catalog) emits a baseline summary and exits 0.
 * On build-catalog failure, exits non-zero and propagates stderr.
 *
 * Usage:
 *   node scripts/dd-338-refresh-catalog.mjs
 *
 * Operational runbook: docs/dd-338-marketplace-refresh.md
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = join(ROOT, "dist");
const CATALOG_PATH = join(DIST_DIR, "catalog.json");
const PREV_PATH = join(DIST_DIR, "catalog.json.prev");
const SUMMARY_PATH = join(DIST_DIR, "dd-338-refresh-summary.json");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-catalog.js");

/** Test whether a filesystem path exists (file or dir). */
async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a structured diff between a prior catalog and a new catalog.
 *
 * Diff shape:
 *   {
 *     baseline: bool,            // true when no prior catalog existed
 *     added:    [name, ...],     // entries present in new but not prev
 *     removed:  [name, ...],     // entries present in prev but not new
 *     changed:  [{ name, type, tier_change, readiness_change, tool_changes }],
 *     summary:  { added, removed, changed, tool_flips_total }
 *   }
 *
 * `tool_changes` is a list of `{ tool, field, before, after }` rows for any
 * tools[].granularity declaration flip OR tools[] add/remove inside an entry
 * present in both catalogs. The four fields tracked are the granularity axes:
 * scope_filtering, field_projection, deterministic_ordering, audit_surface,
 * plus domain_scope when present (DD-333 F.4).
 *
 * Exported for testing.
 */
export function diffCatalogs(prevCatalog, newCatalog) {
  const granularityAxes = [
    "scope_filtering",
    "field_projection",
    "deterministic_ordering",
    "audit_surface",
    "domain_scope",
  ];

  // First-run baseline: no prior catalog. Every entry is a fresh add.
  if (prevCatalog === null) {
    const data = Array.isArray(newCatalog?.data) ? newCatalog.data : [];
    return {
      baseline: true,
      added: data.map((e) => e.name).sort(),
      removed: [],
      changed: [],
      summary: {
        added: data.length,
        removed: 0,
        changed: 0,
        tool_flips_total: 0,
      },
    };
  }

  const prevData = Array.isArray(prevCatalog?.data) ? prevCatalog.data : [];
  const newData = Array.isArray(newCatalog?.data) ? newCatalog.data : [];

  const prevByName = new Map(prevData.map((e) => [e.name, e]));
  const newByName = new Map(newData.map((e) => [e.name, e]));

  const added = [];
  const removed = [];
  const changed = [];
  let toolFlipsTotal = 0;

  for (const [name, _entry] of newByName) {
    if (!prevByName.has(name)) added.push(name);
  }
  for (const [name, _entry] of prevByName) {
    if (!newByName.has(name)) removed.push(name);
  }

  for (const [name, newEntry] of newByName) {
    const prevEntry = prevByName.get(name);
    if (!prevEntry) continue;

    const tierChange =
      prevEntry.tier !== newEntry.tier
        ? { before: prevEntry.tier ?? null, after: newEntry.tier ?? null }
        : null;
    const readinessChange =
      prevEntry.readiness !== newEntry.readiness
        ? {
            before: prevEntry.readiness ?? null,
            after: newEntry.readiness ?? null,
          }
        : null;

    // Per-tool granularity diff. Tools live on tools[]; not all catalog
    // entries declare them (packs don't), so default to empty arrays.
    const prevTools = new Map(
      (Array.isArray(prevEntry.tools) ? prevEntry.tools : [])
        .filter((t) => t && typeof t.name === "string")
        .map((t) => [t.name, t]),
    );
    const newTools = new Map(
      (Array.isArray(newEntry.tools) ? newEntry.tools : [])
        .filter((t) => t && typeof t.name === "string")
        .map((t) => [t.name, t]),
    );

    const toolChanges = [];

    for (const [toolName, newTool] of newTools) {
      const prevTool = prevTools.get(toolName);
      if (!prevTool) {
        toolChanges.push({
          tool: toolName,
          field: "presence",
          before: null,
          after: "added",
        });
        toolFlipsTotal += 1;
        continue;
      }
      const prevGran = prevTool.granularity || {};
      const newGran = newTool.granularity || {};
      for (const axis of granularityAxes) {
        const before = prevGran[axis] ?? null;
        const after = newGran[axis] ?? null;
        if (before !== after) {
          toolChanges.push({ tool: toolName, field: axis, before, after });
          toolFlipsTotal += 1;
        }
      }
    }

    for (const [toolName, _prevTool] of prevTools) {
      if (!newTools.has(toolName)) {
        toolChanges.push({
          tool: toolName,
          field: "presence",
          before: "present",
          after: "removed",
        });
        toolFlipsTotal += 1;
      }
    }

    if (tierChange || readinessChange || toolChanges.length > 0) {
      changed.push({
        name,
        type: newEntry.type ?? null,
        tier_change: tierChange,
        readiness_change: readinessChange,
        tool_changes: toolChanges,
      });
    }
  }

  added.sort();
  removed.sort();
  changed.sort((a, b) => a.name.localeCompare(b.name));

  return {
    baseline: false,
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      tool_flips_total: toolFlipsTotal,
    },
  };
}

/** Render a brief human-readable summary string from a diff object. */
export function formatSummary(diff, { generatedAt } = {}) {
  const lines = [];
  if (diff.baseline) {
    lines.push(
      `Baseline run — no prior catalog. ${diff.summary.added} entries indexed as initial state.`,
    );
  } else {
    const { added, removed, changed, tool_flips_total } = diff.summary;
    if (added === 0 && removed === 0 && changed === 0) {
      lines.push("No catalog changes detected.");
    } else {
      lines.push(
        `Catalog diff: +${added} added, -${removed} removed, ~${changed} changed (${tool_flips_total} tool-level flip(s)).`,
      );
      for (const name of diff.added) lines.push(`  + ${name}`);
      for (const name of diff.removed) lines.push(`  - ${name}`);
      for (const entry of diff.changed) {
        const bits = [];
        if (entry.tier_change)
          bits.push(`tier ${entry.tier_change.before}→${entry.tier_change.after}`);
        if (entry.readiness_change)
          bits.push(
            `readiness ${entry.readiness_change.before}→${entry.readiness_change.after}`,
          );
        if (entry.tool_changes.length > 0)
          bits.push(`${entry.tool_changes.length} tool flip(s)`);
        lines.push(`  ~ ${entry.name}: ${bits.join(", ")}`);
      }
    }
  }
  if (generatedAt) lines.push(`Generated: ${generatedAt}`);
  lines.push(`Summary written: ${SUMMARY_PATH}`);
  return lines.join("\n");
}

/** Run `node scripts/build-catalog.js` as a child process, inheriting stdio. */
function runBuildCatalog() {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [BUILD_SCRIPT], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("error", rejectBuild);
    child.on("close", (code) => {
      if (code === 0) resolveBuild();
      else
        rejectBuild(
          new Error(`scripts/build-catalog.js exited with code ${code}`),
        );
    });
  });
}

async function readCatalogIfExists(path) {
  if (!(await pathExists(path))) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

async function main() {
  await mkdir(DIST_DIR, { recursive: true });

  // Step 1 — snapshot existing catalog (if any). We move-rename rather than
  // copy so the next build-catalog run produces a clean new file. The prev
  // file is what we diff against; the new file is the post-build artefact.
  const hadPrev = await pathExists(CATALOG_PATH);
  if (hadPrev) {
    await rename(CATALOG_PATH, PREV_PATH);
  }

  // Step 2 — regenerate. build-catalog.js handles its own logging.
  await runBuildCatalog();

  // Step 3 — read both catalogs and diff. prev may not exist on first run.
  const prevCatalog = await readCatalogIfExists(PREV_PATH);
  const newCatalog = await readCatalogIfExists(CATALOG_PATH);
  if (!newCatalog) {
    throw new Error(
      `build-catalog.js completed but ${CATALOG_PATH} is missing. Cannot diff.`,
    );
  }

  const diff = diffCatalogs(prevCatalog, newCatalog);

  // Step 4 — emit summary JSON.
  const generatedAt = new Date().toISOString();
  const summary = {
    generated: generatedAt,
    dd: "DD-338",
    phase: "D.5",
    catalog_meta: newCatalog.meta ?? null,
    diff,
  };
  await writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");

  // Step 5 — human readable.
  console.log("");
  console.log("--- DD-338 D.5 refresh summary ---");
  console.log(formatSummary(diff, { generatedAt }));
}

// Run main() only when executed directly (not imported as a module).
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
}
