/**
 * DD-333 Phase A.6 — catalog-entry schema fixture tests.
 *
 * Three fixtures exercise the AJV gate added in Phase A.1:
 *   - tool-with-granularity.json    — valid; tools[] carries full granularity blocks
 *   - tool-missing-granularity.json — valid; tools[] present but granularity omitted (additive optional at pack-spec 3.x)
 *   - tool-malformed-granularity.json — invalid; one out-of-enum value + one missing required dimension
 *
 * As an additional smoke gate, every real plugin entry under plugins/tools/
 * must validate against the schema — this catches regressions where the
 * additive surface tightens accidentally.
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

  it("accepts entry with tools[] but no granularity blocks (additive optional at 3.x)", async () => {
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
