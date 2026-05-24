import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diffCatalogs, formatSummary } from "./dd-338-refresh-catalog.mjs";

// ---------------------------------------------------------------------------
// diffCatalogs — baseline (no prior catalog)
// ---------------------------------------------------------------------------

describe("diffCatalogs — first-run baseline", () => {
  it("treats every entry as an add when prev is null", () => {
    const newCatalog = {
      meta: { total: 2 },
      data: [
        { name: "alpha", type: "plugin", tier: "certified" },
        { name: "beta", type: "pack", tier: "community" },
      ],
    };
    const diff = diffCatalogs(null, newCatalog);
    assert.equal(diff.baseline, true);
    assert.deepEqual(diff.added, ["alpha", "beta"]);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.changed, []);
    assert.equal(diff.summary.added, 2);
    assert.equal(diff.summary.removed, 0);
    assert.equal(diff.summary.changed, 0);
    assert.equal(diff.summary.tool_flips_total, 0);
  });

  it("handles empty new catalog on baseline run", () => {
    const diff = diffCatalogs(null, { data: [] });
    assert.equal(diff.baseline, true);
    assert.deepEqual(diff.added, []);
    assert.equal(diff.summary.added, 0);
  });
});

// ---------------------------------------------------------------------------
// diffCatalogs — identical catalogs (empty diff)
// ---------------------------------------------------------------------------

describe("diffCatalogs — identical catalogs", () => {
  it("returns zero deltas when prev and new are deep-equal", () => {
    const catalog = {
      meta: { total: 1 },
      data: [
        {
          name: "alpha",
          type: "plugin",
          tier: "certified",
          readiness: "production",
          tools: [
            {
              name: "alpha_list",
              granularity: {
                scope_filtering: "server-side",
                field_projection: "explicit",
                deterministic_ordering: "stable",
                audit_surface: "complete",
              },
            },
          ],
        },
      ],
    };
    // Clone via JSON to make sure object identity doesn't fool the diff.
    const prev = JSON.parse(JSON.stringify(catalog));
    const next = JSON.parse(JSON.stringify(catalog));
    const diff = diffCatalogs(prev, next);
    assert.equal(diff.baseline, false);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.changed, []);
    assert.equal(diff.summary.tool_flips_total, 0);
  });
});

// ---------------------------------------------------------------------------
// diffCatalogs — single tool granularity flip
// ---------------------------------------------------------------------------

describe("diffCatalogs — single tool flip", () => {
  it("reports one tool change when deterministic_ordering flips", () => {
    const prev = {
      data: [
        {
          name: "alpha",
          type: "plugin",
          tier: "certified",
          tools: [
            {
              name: "alpha_query",
              granularity: {
                scope_filtering: "server-side",
                field_projection: "explicit",
                deterministic_ordering: "unstable",
                audit_surface: "complete",
              },
            },
          ],
        },
      ],
    };
    const next = {
      data: [
        {
          name: "alpha",
          type: "plugin",
          tier: "certified",
          tools: [
            {
              name: "alpha_query",
              granularity: {
                scope_filtering: "server-side",
                field_projection: "explicit",
                deterministic_ordering: "stable",
                audit_surface: "complete",
              },
            },
          ],
        },
      ],
    };
    const diff = diffCatalogs(prev, next);
    assert.equal(diff.baseline, false);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].name, "alpha");
    assert.equal(diff.changed[0].tool_changes.length, 1);
    assert.deepEqual(diff.changed[0].tool_changes[0], {
      tool: "alpha_query",
      field: "deterministic_ordering",
      before: "unstable",
      after: "stable",
    });
    assert.equal(diff.summary.tool_flips_total, 1);
    assert.equal(diff.changed[0].tier_change, null);
    assert.equal(diff.changed[0].readiness_change, null);
  });

  it("reports tier change when entry tier flips", () => {
    const prev = {
      data: [{ name: "beta", type: "plugin", tier: "community" }],
    };
    const next = {
      data: [{ name: "beta", type: "plugin", tier: "verified" }],
    };
    const diff = diffCatalogs(prev, next);
    assert.equal(diff.changed.length, 1);
    assert.deepEqual(diff.changed[0].tier_change, {
      before: "community",
      after: "verified",
    });
  });
});

// ---------------------------------------------------------------------------
// diffCatalogs — adds, removes, mixed deltas
// ---------------------------------------------------------------------------

describe("diffCatalogs — adds and removes", () => {
  it("captures added and removed entries by name", () => {
    const prev = {
      data: [
        { name: "alpha", type: "plugin" },
        { name: "beta", type: "plugin" },
      ],
    };
    const next = {
      data: [
        { name: "alpha", type: "plugin" },
        { name: "gamma", type: "pack" },
      ],
    };
    const diff = diffCatalogs(prev, next);
    assert.deepEqual(diff.added, ["gamma"]);
    assert.deepEqual(diff.removed, ["beta"]);
    assert.deepEqual(diff.changed, []);
  });

  it("captures tool add and tool remove within the same entry", () => {
    const prev = {
      data: [
        {
          name: "alpha",
          type: "plugin",
          tools: [{ name: "tool_a" }, { name: "tool_b" }],
        },
      ],
    };
    const next = {
      data: [
        {
          name: "alpha",
          type: "plugin",
          tools: [{ name: "tool_a" }, { name: "tool_c" }],
        },
      ],
    };
    const diff = diffCatalogs(prev, next);
    assert.equal(diff.changed.length, 1);
    const flips = diff.changed[0].tool_changes;
    assert.equal(flips.length, 2);
    const added = flips.find((f) => f.tool === "tool_c");
    const removed = flips.find((f) => f.tool === "tool_b");
    assert.deepEqual(added, {
      tool: "tool_c",
      field: "presence",
      before: null,
      after: "added",
    });
    assert.deepEqual(removed, {
      tool: "tool_b",
      field: "presence",
      before: "present",
      after: "removed",
    });
    assert.equal(diff.summary.tool_flips_total, 2);
  });
});

// ---------------------------------------------------------------------------
// formatSummary — human-readable rendering
// ---------------------------------------------------------------------------

describe("formatSummary", () => {
  it("renders baseline label on first run", () => {
    const text = formatSummary({
      baseline: true,
      added: ["a", "b"],
      removed: [],
      changed: [],
      summary: { added: 2, removed: 0, changed: 0, tool_flips_total: 0 },
    });
    assert.match(text, /Baseline run/);
    assert.match(text, /2 entries indexed/);
  });

  it("renders empty-diff label when no changes", () => {
    const text = formatSummary({
      baseline: false,
      added: [],
      removed: [],
      changed: [],
      summary: { added: 0, removed: 0, changed: 0, tool_flips_total: 0 },
    });
    assert.match(text, /No catalog changes detected/);
  });

  it("renders tool flip counts when changes present", () => {
    const text = formatSummary({
      baseline: false,
      added: [],
      removed: [],
      changed: [
        {
          name: "alpha",
          type: "plugin",
          tier_change: null,
          readiness_change: null,
          tool_changes: [
            {
              tool: "alpha_q",
              field: "deterministic_ordering",
              before: "unstable",
              after: "stable",
            },
          ],
        },
      ],
      summary: { added: 0, removed: 0, changed: 1, tool_flips_total: 1 },
    });
    assert.match(text, /\+0 added, -0 removed, ~1 changed/);
    assert.match(text, /1 tool-level flip/);
    assert.match(text, /~ alpha:/);
  });
});
