/**
 * DD-333 catalog-entry schema fixture tests.
 *
 * Fixtures exercising the AJV gate:
 *   - tool-with-granularity.json                              — valid; tools[] carries full granularity blocks
 *   - tool-missing-granularity.json                           — AJV accepts (DD-333 F.1: tools[].items.required relaxed to ["name"]; cross-field constraint now enforced procedurally in build-catalog.js); see build-catalog.test.js for the procedural reject.
 *   - tool-malformed-granularity.json                         — invalid; one out-of-enum value + one missing required dimension
 *   - tool-non-conformance-rationale-valid.json               — valid; rationale block + one tool in affected_tools (no granularity) + one tool with full granularity
 *   - tool-non-conformance-rationale-scope-off-false.json     — invalid; AJV const:true rejects
 *   - tool-non-conformance-rationale-empty-contamination.json — invalid; AJV minItems:1 rejects
 *   - tool-non-conformance-rationale-affected-tools-mismatch.json — AJV accepts (cross-field invariant lives procedurally in build-catalog.js).
 *
 * As an additional smoke gate, every real plugin entry under plugins/tools/
 * must validate against the schema — this catches regressions and confirms
 * the Phase A.3 sweep declarations are complete.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { validateCatalogEntry } from "./build-catalog.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_DIR = join(ROOT, "schemas", "fixtures", "catalog-entries");
const TOOLS_DIR = join(ROOT, "plugins", "tools");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

describe("DD-333 catalog-entry schema — granularity fixtures", () => {
  it("accepts entry with fully-declared per-tool granularity", async () => {
    const entry = loadFixture("tool-with-granularity.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, true, verdict.errorsText);
  });

  it("AJV accepts entry with tools[] but no granularity (DD-333 F.1: cross-field constraint enforced procedurally in build-catalog.js)", async () => {
    // DD-333 F.1: tools[].items.required relaxed to ["name"] only because the
    // cross-field constraint "granularity OR present-in-affected_tools" cannot
    // be expressed cleanly in JSON Schema 2020-12. AJV passes; the procedural
    // gate in build-catalog.js enforceNonConformanceRationale() is the canonical
    // rejection point (see build-catalog.test.js for the procedural reject
    // regression coverage).
    const entry = loadFixture("tool-missing-granularity.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, true, verdict.errorsText);
  });

  it("rejects entry with out-of-enum scope_filtering value", async () => {
    const entry = loadFixture("tool-malformed-granularity.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, false);
    // The fixture violates at /tools/0/granularity/scope_filtering and
    // /tools/1/granularity (missing audit_surface). At least one error
    // must reference scope_filtering's enum failure.
    const hasScopeEnumError = verdict.errors.some(
      (e) =>
        e.instancePath.includes("/tools/0/granularity/scope_filtering") ||
        (e.params && e.params.allowedValues &&
         Array.isArray(e.params.allowedValues) &&
         e.params.allowedValues.includes("server-side")),
    );
    assert.ok(
      hasScopeEnumError,
      `Expected scope_filtering enum error; got: ${verdict.errorsText}`,
    );
  });

  it("rejects entry whose granularity block omits a required dimension", async () => {
    const entry = loadFixture("tool-malformed-granularity.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, false);
    const hasMissingDim = verdict.errors.some(
      (e) =>
        e.params &&
        e.params.missingProperty === "audit_surface" &&
        e.instancePath.includes("/tools/1/granularity"),
    );
    assert.ok(
      hasMissingDim,
      `Expected missing audit_surface; got: ${verdict.errorsText}`,
    );
  });
});

describe("DD-333 F.1 catalog-entry schema — non_conformance_rationale fixtures", () => {
  it("accepts entry with valid non_conformance_rationale block", async () => {
    const entry = loadFixture("tool-non-conformance-rationale-valid.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, true, verdict.errorsText);
  });

  it("rejects scope_filtering_off: false (const:true)", async () => {
    const entry = loadFixture("tool-non-conformance-rationale-scope-off-false.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, false);
    const hasConstError = verdict.errors.some(
      (e) =>
        e.instancePath === "/non_conformance_rationale/scope_filtering_off" &&
        e.keyword === "const",
    );
    assert.ok(
      hasConstError,
      `Expected const error on scope_filtering_off; got: ${verdict.errorsText}`,
    );
  });

  it("rejects empty contamination_risks (minItems:1)", async () => {
    const entry = loadFixture("tool-non-conformance-rationale-empty-contamination.json");
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, false);
    const hasMinItems = verdict.errors.some(
      (e) =>
        e.instancePath === "/non_conformance_rationale/contamination_risks" &&
        e.keyword === "minItems",
    );
    assert.ok(
      hasMinItems,
      `Expected minItems error on contamination_risks; got: ${verdict.errorsText}`,
    );
  });

  it("rejects bogus contamination_risks enum value", async () => {
    // Synthesise inline — keeps the fixture corpus tight.
    const entry = {
      name: "nrr-bogus-risk-blade-mcp",
      type: "plugin",
      description: "DD-333 F.1 inline fixture — bogus contamination_risks enum value.",
      version: "1.0.0",
      author: "stallari",
      license: "MIT",
      tier: "community",
      author_type: "community",
      contract: "example-v1",
      repository: "https://github.com/Groupthink-dev/nrr-bogus-risk-blade-mcp",
      install: { runtime: "uv", package: "nrr-bogus-risk-blade-mcp" },
      tools: [{ name: "dump_legacy", description: "Legacy endpoint." }],
      non_conformance_rationale: {
        reason: "Upstream IMAP backend lacks per-folder scope.",
        scope_filtering_off: true,
        contamination_risks: ["bogus-risk"],
        affected_tools: ["dump_legacy"],
      },
    };
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, false);
    const hasEnumError = verdict.errors.some(
      (e) =>
        e.keyword === "enum" &&
        e.instancePath.startsWith("/non_conformance_rationale/contamination_risks/"),
    );
    assert.ok(
      hasEnumError,
      `Expected enum error on contamination_risks[0]; got: ${verdict.errorsText}`,
    );
  });

  it("AJV accepts affected_tools mismatch (cross-field constraint enforced procedurally)", async () => {
    // AJV cannot express cross-field invariants in JSON Schema 2020-12. The
    // build-catalog.js enforceNonConformanceRationale() function rejects this
    // shape; AJV alone passes. See build-catalog.test.js for the procedural
    // reject coverage.
    const entry = loadFixture(
      "tool-non-conformance-rationale-affected-tools-mismatch.json",
    );
    const verdict = await validateCatalogEntry(entry);
    assert.equal(verdict.valid, true, verdict.errorsText);
  });
});

describe("DD-333 catalog-entry schema — real plugin entries smoke gate", () => {
  const pluginFiles = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of pluginFiles) {
    it(`accepts plugins/tools/${file}`, async () => {
      const raw = JSON.parse(readFileSync(join(TOOLS_DIR, file), "utf-8"));
      const verdict = await validateCatalogEntry(raw);
      assert.equal(
        verdict.valid,
        true,
        `Schema regression on ${file}:\n${verdict.errorsText}`,
      );
    });
  }
});
