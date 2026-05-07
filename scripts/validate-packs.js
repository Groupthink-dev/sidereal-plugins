#!/usr/bin/env node
/**
 * Validate all pack YAML manifests in plugins/packs/ against the
 * Pack Spec v1.0/v1.1/v1.2 rules. Mirrors worker/src/validate.ts logic.
 *
 * Usage: node scripts/validate-packs.js
 * Exit code: 0 if all valid, 1 if any errors found.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DECLARED_SERVICES } from "./generated/declared-services.js";

const ROOT = resolve(import.meta.dirname, "..");
const PACKS_DIR = join(ROOT, "plugins", "packs");
const SCHEMAS_DIR = join(ROOT, "schemas");
const PRIVATE_PACKS_DIR = process.env.PRIVATE_PACKS_DIR || null;

// Load controlled vocabularies synced from pack-spec (make sync-pack-spec).
const ENUMS = JSON.parse(readFileSync(join(SCHEMAS_DIR, "schema-enums.json"), "utf-8"));
const SKILL_CATS = JSON.parse(readFileSync(join(SCHEMAS_DIR, "skill-categories.json"), "utf-8"));

const VALID_PACK_VERSIONS = ENUMS.PACK_VERSIONS;
const VALID_VISIBILITIES = ENUMS.VISIBILITIES;
const VALID_DATA_STORES = ENUMS.DATA_STORES;
const VALID_TIERS = ENUMS.TIERS;
const VALID_PRICING_MODELS = ENUMS.PRICING_MODELS;
const VALID_SKILL_CATEGORIES = SKILL_CATS.categories.map((c) => c.name);

// Registry-local business rules (not part of pack-spec).
const VALID_ACCESS = ["public", "private"];
const VALID_KEY_DELIVERY = ["paddle", "registry-escrow", "direct"];
const SEALED_ALLOWED_TIERS = ["certified", "verified"];
const FIRST_PARTY_AUTHOR_URLS = ["https://stallari.ai", "https://sidereal.cc"];

function validatePack(parsed) {
  const errors = [];

  if (!parsed || typeof parsed !== "object") {
    return ["Manifest must be a YAML mapping"];
  }

  // pack version
  if (!parsed.pack) {
    errors.push('Missing required field: "pack"');
  } else if (!VALID_PACK_VERSIONS.includes(String(parsed.pack))) {
    errors.push(`Unsupported pack version: "${parsed.pack}" (expected: ${VALID_PACK_VERSIONS.join(", ")})`);
  }

  // name
  if (!parsed.name || typeof parsed.name !== "string") {
    errors.push('Missing required field: "name"');
  }

  // description
  if (!parsed.description || typeof parsed.description !== "string") {
    errors.push('Missing required field: "description"');
  }

  // author
  if (parsed.author !== undefined) {
    if (typeof parsed.author !== "object" || parsed.author === null) {
      errors.push('"author" must be an object with "name"');
    } else if (!parsed.author.name || typeof parsed.author.name !== "string") {
      errors.push("author.name is required");
    }
  }

  // min_stallari
  if (parsed.min_stallari !== undefined) {
    if (!/^\d+\.\d+$/.test(String(parsed.min_stallari))) {
      errors.push(`Invalid min_stallari format: "${parsed.min_stallari}" (expected "X.Y")`);
    }
  }

  // data block
  if (!parsed.data || typeof parsed.data !== "object") {
    errors.push('Missing required field: "data"');
  } else {
    const { reads, writes, stores, phones_home } = parsed.data;
    if (!Array.isArray(reads)) {
      errors.push("data.reads must be an array");
    } else {
      for (const s of reads) {
        if (!DECLARED_SERVICES.includes(s)) errors.push(`Unknown service "${s}" in data.reads`);
      }
    }
    if (!Array.isArray(writes)) {
      errors.push("data.writes must be an array");
    } else {
      for (const s of writes) {
        if (!DECLARED_SERVICES.includes(s)) errors.push(`Unknown service "${s}" in data.writes`);
      }
    }
    if (stores === undefined) {
      errors.push("data.stores is required");
    } else if (!VALID_DATA_STORES.includes(String(stores))) {
      errors.push(`Invalid data.stores: "${stores}"`);
    }
    if (phones_home === undefined) {
      errors.push("data.phones_home is required");
    } else if (typeof phones_home !== "boolean") {
      errors.push("data.phones_home must be a boolean");
    }
  }

  // skills
  if (!Array.isArray(parsed.skills) || parsed.skills.length === 0) {
    errors.push('"skills" must be a non-empty array');
  } else {
    const names = new Set();
    for (let i = 0; i < parsed.skills.length; i++) {
      const skill = parsed.skills[i];
      if (!skill || typeof skill !== "object") { errors.push(`skills[${i}] must be an object`); continue; }
      // DD-234 (pack format v1.11+): skills may use the `import:` primitive
      // instead of inline `name`/`description`/`prompt`. The skill body lives
      // at a relative SKILL.md path; name/description/prompt are derived from
      // its frontmatter+body at load time. The validator skips the inline
      // shape checks for these and asserts the import path is well-formed.
      if (skill.import !== undefined) {
        if (typeof skill.import !== "string" || !skill.import) {
          errors.push(`skills[${i}].import must be a non-empty string`);
        } else {
          if (!skill.import.endsWith(".md")) {
            errors.push(`skills[${i}].import "${skill.import}" must end in .md`);
          }
          if (skill.import.includes("..")) {
            errors.push(`skills[${i}].import "${skill.import}" must not contain '..' segments (path-traversal guard)`);
          }
          if (skill.import.startsWith("/")) {
            errors.push(`skills[${i}].import "${skill.import}" must be a relative path (no leading '/')`);
          }
          if (names.has(skill.import)) {
            errors.push(`Duplicate skill import path: "${skill.import}"`);
          } else {
            names.add(skill.import);
          }
        }
        // import:-form skills bypass inline name/prompt checks. Other
        // per-skill checks below (services_used, trigger, inputs, outputs,
        // category) still apply uniformly.
      } else {
        if (!skill.name || typeof skill.name !== "string") errors.push(`skills[${i}].name is required`);
        else { if (names.has(skill.name)) errors.push(`Duplicate skill name: "${skill.name}"`); names.add(skill.name); }
        if (!skill.prompt || typeof skill.prompt !== "string") errors.push(`skills[${i}].prompt is required`);
      }
      // category (v1.2)
      if (skill.category !== undefined) {
        if (!VALID_SKILL_CATEGORIES.includes(String(skill.category))) {
          errors.push(`skills[${i}].category "${skill.category}" is invalid. Must be: ${VALID_SKILL_CATEGORIES.join(", ")}`);
        }
      }
      // services_used (v1.2)
      if (skill.services_used !== undefined) {
        if (!Array.isArray(skill.services_used)) {
          errors.push(`skills[${i}].services_used must be an array`);
        } else {
          for (let j = 0; j < skill.services_used.length; j++) {
            const su = skill.services_used[j];
            if (!su || typeof su !== "object") { errors.push(`skills[${i}].services_used[${j}] must be an object`); continue; }
            if (!su.service || typeof su.service !== "string") {
              errors.push(`skills[${i}].services_used[${j}].service is required`);
            } else if (!DECLARED_SERVICES.includes(su.service)) {
              errors.push(`Unknown service "${su.service}" in skills[${i}].services_used`);
            }
            if (su.operations !== undefined && !Array.isArray(su.operations)) {
              errors.push(`skills[${i}].services_used[${j}].operations must be an array`);
            }
          }
        }
      }
      // webhook_name (v1.4)
      if (skill.webhook_name !== undefined) {
        if (typeof skill.webhook_name !== "string" || !skill.webhook_name) {
          errors.push(`skills[${i}].webhook_name must be a non-empty string`);
        }
      }
      // trigger.webhook (v1.4)
      if (skill.trigger !== undefined) {
        if (typeof skill.trigger !== "object" || skill.trigger === null) {
          errors.push(`skills[${i}].trigger must be an object`);
        } else if (skill.trigger.webhook !== undefined) {
          const wh = skill.trigger.webhook;
          if (typeof wh !== "object" || wh === null) {
            errors.push(`skills[${i}].trigger.webhook must be an object`);
          } else {
            if (!wh.path || typeof wh.path !== "string") {
              errors.push(`skills[${i}].trigger.webhook.path is required`);
            }
            if (wh.auth !== undefined && typeof wh.auth !== "string") {
              errors.push(`skills[${i}].trigger.webhook.auth must be a string`);
            }
          }
        }
      }
      // inputs (v1.2)
      if (skill.inputs !== undefined && !Array.isArray(skill.inputs)) {
        errors.push(`skills[${i}].inputs must be an array`);
      }
      // outputs (v1.2)
      if (skill.outputs !== undefined) {
        if (!Array.isArray(skill.outputs)) {
          errors.push(`skills[${i}].outputs must be an array`);
        } else {
          for (let j = 0; j < skill.outputs.length; j++) {
            const out = skill.outputs[j];
            if (!out || typeof out !== "object") { errors.push(`skills[${i}].outputs[${j}] must be an object`); continue; }
            if (!out.type || typeof out.type !== "string") errors.push(`skills[${i}].outputs[${j}].type is required`);
          }
        }
      }
    }
  }

  // requires/recommends
  for (const field of ["requires", "recommends"]) {
    const block = parsed[field];
    if (!block || typeof block !== "object") continue;
    if (!Array.isArray(block.services)) continue;
    for (let i = 0; i < block.services.length; i++) {
      const svc = block.services[i];
      if (!svc?.service) { errors.push(`${field}.services[${i}].service is required`); continue; }
      if (!DECLARED_SERVICES.includes(svc.service)) {
        errors.push(`Unknown service "${svc.service}" in ${field}.services`);
      }
    }
  }

  // visibility
  if (parsed.visibility !== undefined && !VALID_VISIBILITIES.includes(String(parsed.visibility))) {
    errors.push(`Invalid visibility: "${parsed.visibility}"`);
  }

  // tier (v1.1)
  if (parsed.tier !== undefined && !VALID_TIERS.includes(String(parsed.tier))) {
    errors.push(`Invalid tier: "${parsed.tier}"`);
  }

  // pricing (v1.1)
  if (parsed.pricing !== undefined && parsed.pricing !== null) {
    if (typeof parsed.pricing !== "object") {
      errors.push('"pricing" must be null or an object');
    } else {
      if (parsed.pricing.model !== undefined && !VALID_PRICING_MODELS.includes(String(parsed.pricing.model))) {
        errors.push(`Invalid pricing.model: "${parsed.pricing.model}"`);
      }
    }
  }

  // forked_from (v1.2)
  if (parsed.forked_from !== undefined) {
    if (typeof parsed.forked_from !== "object" || parsed.forked_from === null) {
      errors.push('"forked_from" must be an object with "name" and "version"');
    } else {
      if (!parsed.forked_from.name || typeof parsed.forked_from.name !== "string") errors.push("forked_from.name is required");
      if (!parsed.forked_from.version || typeof parsed.forked_from.version !== "string") errors.push("forked_from.version is required");
    }
  }

  // encryption (v1.2) — structure validation for any pack declaring encryption
  if (parsed.encryption !== undefined) {
    if (typeof parsed.encryption !== "object" || parsed.encryption === null) {
      errors.push('"encryption" must be an object with "method" and "key_delivery"');
    } else {
      if (!parsed.encryption.method || typeof parsed.encryption.method !== "string") {
        errors.push("encryption.method is required");
      } else if (parsed.encryption.method !== "aes-256-gcm") {
        errors.push(`Unsupported encryption.method: "${parsed.encryption.method}" (only "aes-256-gcm" supported)`);
      }
      if (!parsed.encryption.key_delivery || typeof parsed.encryption.key_delivery !== "string") {
        errors.push("encryption.key_delivery is required");
      } else if (!VALID_KEY_DELIVERY.includes(parsed.encryption.key_delivery)) {
        errors.push(`Invalid encryption.key_delivery: "${parsed.encryption.key_delivery}" (expected: ${VALID_KEY_DELIVERY.join(", ")})`);
      }
    }
  }

  // access (v1.3)
  if (parsed.access !== undefined && !VALID_ACCESS.includes(String(parsed.access))) {
    errors.push(`Invalid access: "${parsed.access}" (expected: ${VALID_ACCESS.join(", ")})`);
  }

  // organization (v1.3) — required when access is private
  if (String(parsed.access) === "private") {
    if (!parsed.organization || typeof parsed.organization !== "string") {
      errors.push('Private packs require an "organization" field');
    } else if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed.organization)) {
      errors.push(`Invalid organization slug: "${parsed.organization}" (must be lowercase alphanumeric with hyphens)`);
    }
  }
  if (parsed.organization !== undefined && String(parsed.access || "public") !== "private") {
    errors.push('"organization" field is only valid when access is "private"');
  }

  // ── Sealed pack rules ────────────────────────────────────────────
  if (String(parsed.visibility) === "sealed") {
    // DD-120 Phase 0: third-party sealed distribution gate
    // Sealed packs may only be public if published by a first-party author.
    // Third-party sealed packs must use access: "private" until the
    // certification pipeline (DD-120 Phases 1-5) is operational.
    if (String(parsed.access || "public") !== "private") {
      const authorUrl = parsed.author?.url;
      if (!authorUrl || !FIRST_PARTY_AUTHOR_URLS.includes(authorUrl)) {
        errors.push(
          'Sealed packs require access: "private" unless published by a first-party author (DD-120)'
        );
      }
    }

    // readme required
    if (!parsed.readme) {
      errors.push('Sealed packs require a "readme" field');
    }

    // encryption block required
    if (!parsed.encryption) {
      errors.push('Sealed packs require an "encryption" block');
    }

    // pricing required for public sealed packs, must not be free
    // private sealed packs may omit pricing (internal org packs)
    if (String(parsed.access || "public") === "public") {
      if (!parsed.pricing) {
        errors.push('Public sealed packs require a "pricing" block');
      } else if (parsed.pricing.model === "free") {
        errors.push('Sealed packs cannot use pricing.model "free"');
      }
    }

    // tier must be certified or verified
    if (!parsed.tier || !SEALED_ALLOWED_TIERS.includes(String(parsed.tier))) {
      errors.push(`Sealed packs require tier "certified" or "verified" (got "${parsed.tier || "none"}")`);
    }

    // every skill prompt must be >= 20 chars (prevents accidentally empty sealed prompts)
    if (Array.isArray(parsed.skills)) {
      for (let i = 0; i < parsed.skills.length; i++) {
        const skill = parsed.skills[i];
        if (skill?.prompt && typeof skill.prompt === "string" && skill.prompt.length < 20) {
          errors.push(`skills[${i}] ("${skill.name}") prompt too short for sealed pack (${skill.prompt.length} chars, min 20)`);
        }
      }
    }
  }

  return errors;
}

async function validateDir(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  } catch {
    return 0;
  }

  let errors = 0;
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf-8");
    let parsed;
    try {
      parsed = parseYaml(content);
    } catch (err) {
      console.log(`  FAIL  ${file}: YAML parse error: ${err.message}`);
      errors++;
      continue;
    }

    const fileErrors = validatePack(parsed);
    if (fileErrors.length === 0) {
      console.log(`  PASS  ${file}`);
    } else {
      console.log(`  FAIL  ${file}`);
      for (const e of fileErrors) console.log(`        - ${e}`);
      errors++;
    }
  }
  return errors;
}

/**
 * Validate pre-sealed pack artifacts from a directory structured as:
 *   {dir}/{slug}/{version}/manifest.json + payload.enc + seal-key.hex
 *
 * Structural validation only — cryptographic verification is done by
 * stallari-registry-infra/scripts/verify-sealed-packs.mjs.
 */
async function validateSealedDir(dir) {
  let slugs;
  try {
    slugs = await readdir(dir);
  } catch {
    return 0;
  }

  let errors = 0;
  for (const slug of slugs.sort()) {
    const slugDir = join(dir, slug);
    const slugStat = await stat(slugDir).catch(() => null);
    if (!slugStat?.isDirectory()) continue;

    const versions = await readdir(slugDir);
    for (const version of versions.sort()) {
      const packDir = join(slugDir, version);
      const versionStat = await stat(packDir).catch(() => null);
      if (!versionStat?.isDirectory()) continue;

      const label = `${slug}/${version}`;
      const fileErrors = [];

      // Check required files exist
      for (const f of ["manifest.json", "payload.enc", "seal-key.hex"]) {
        const exists = await stat(join(packDir, f)).catch(() => null);
        if (!exists) fileErrors.push(`missing ${f}`);
      }

      // Validate manifest structure
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf-8"));
      } catch (err) {
        fileErrors.push(`manifest.json parse error: ${err.message}`);
      }

      if (manifest) {
        if (!manifest.name) fileErrors.push("missing name");
        if (!manifest.version) fileErrors.push("missing version");
        if (manifest.visibility !== "sealed") fileErrors.push(`visibility is "${manifest.visibility}", expected "sealed"`);
        if (!manifest.seal_metadata) fileErrors.push("missing seal_metadata");
      }

      if (fileErrors.length === 0) {
        console.log(`  PASS  ${label} (sealed)`);
      } else {
        console.log(`  FAIL  ${label} (sealed)`);
        for (const e of fileErrors) console.log(`        - ${e}`);
        errors++;
      }
    }
  }
  return errors;
}

async function main() {
  let totalErrors = await validateDir(PACKS_DIR);

  if (PRIVATE_PACKS_DIR) {
    console.log(`\nValidating pre-sealed packs from PRIVATE_PACKS_DIR...`);
    totalErrors += await validateSealedDir(PRIVATE_PACKS_DIR);
  }

  if (totalErrors > 0) process.exit(1);
}

export { validatePack };

// Run main() only when executed directly (not imported as a module)
const isMain =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
}
