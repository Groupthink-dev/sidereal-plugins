#!/usr/bin/env node
// DD-244 Phase F.0 — Convert pack.yaml `services_used` blocks to v1.12
// `required_services` / `optional_services` declarations.
//
// Reads vocabularies/services.yaml + each contract schema to classify
// operations as required vs optional based on the contract's own
// `classification` field (required → required_services; recommended /
// optional → optional_services).
//
// Idempotent: running twice on the same pack yields the same output.
// Skills that already carry v1.12 `required_services` / `optional_services`
// are left untouched.
//
// Usage:
//   node scripts/migrate-tool-declarations.js plugins/packs/stallari-core.yaml
//   node scripts/migrate-tool-declarations.js plugins/packs/*.yaml
//
// Prints a summary to stdout. Writes back to disk only with --write.
//   node scripts/migrate-tool-declarations.js --write plugins/packs/*.yaml

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, parse, stringify } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PACK_SPEC_ROOT = resolve(REPO_ROOT, "..", "stallari-pack-spec");

// ---------------------------------------------------------------------------
// Load services vocabulary + contract schemas

function loadServiceVocabulary() {
    const path = join(PACK_SPEC_ROOT, "vocabularies", "services.yaml");
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    const map = new Map();
    for (const entry of parsed.services ?? []) {
        map.set(entry.service, entry.contract);
    }
    return map;
}

function loadContractClassifications() {
    // contractId → Map<opName, classification>
    const map = new Map();
    const contractsDir = join(PACK_SPEC_ROOT, "schema", "contracts");
    const files = readdirSyncSafe(contractsDir);
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = readFileSync(join(contractsDir, f), "utf8");
        const parsed = JSON.parse(raw);
        const contractId = parsed.title ?? f.replace(/\.json$/, "");
        const ops = new Map();
        for (const op of parsed.operations ?? []) {
            ops.set(op.name, op.classification ?? "optional");
        }
        map.set(contractId, ops);
    }
    return map;
}

function readdirSyncSafe(p) {
    try {
        // eslint-disable-next-line node/no-sync
        return require("node:fs").readdirSync(p);
    } catch {
        return [];
    }
}

// Replace the require above with ESM-native readdirSync.
import { readdirSync } from "node:fs";

function listContracts() {
    const contractsDir = join(PACK_SPEC_ROOT, "schema", "contracts");
    try {
        return readdirSync(contractsDir);
    } catch {
        return [];
    }
}

function loadContractClassificationsESM() {
    const map = new Map();
    for (const f of listContracts()) {
        if (!f.endsWith(".json")) continue;
        const path = join(PACK_SPEC_ROOT, "schema", "contracts", f);
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        const contractId = parsed.title ?? f.replace(/\.json$/, "");
        const ops = new Map();
        for (const op of parsed.operations ?? []) {
            ops.set(op.name, op.classification ?? "optional");
        }
        map.set(contractId, ops);
    }
    return map;
}

// ---------------------------------------------------------------------------
// Conversion

function classifyOperation(serviceVocab, contractOps, service, operation) {
    // **Default rule:** every op in `services_used` → required_services.
    // The skill author listed it because the skill uses it; absence breaks
    // the skill. Architect promotes specific ops to optional_services
    // during review based on reading the skill body.
    //
    // The script's contract-schema lookup is preserved purely for *drift
    // detection* — emit a warning when a pack-side op isn't in the
    // contract schema, but always classify as required.
    const contractId = serviceVocab.get(service);
    if (!contractId) {
        return { tier: "required", warning: `unknown_service: ${service} (no entry in vocabularies/services.yaml)` };
    }
    const ops = contractOps.get(contractId);
    if (!ops) {
        return { tier: "required", warning: `unknown_contract: ${contractId} (no schema/contracts/${contractId}.json)` };
    }
    const cls = ops.get(operation);
    if (!cls) {
        return { tier: "required", warning: `unknown_operation: ${service}.${operation} (not in ${contractId})` };
    }
    return { tier: "required" };
}

function convertSkill(skillNode, serviceVocab, contractOps, summary) {
    // `skillNode` is a yaml.YAMLMap representing one skill entry.
    const get = (key) => skillNode.get(key);
    const has = (key) => skillNode.has(key);

    // Idempotency: skip if already v1.12-shaped.
    if (has("required_services") || has("required_tools")) {
        summary.skipped += 1;
        return null;
    }

    const servicesUsed = get("services_used");
    if (!servicesUsed || !servicesUsed.items) {
        summary.no_services_used += 1;
        return null;
    }

    const required = [];
    const optional = [];
    const warnings = [];

    for (const su of servicesUsed.items ?? []) {
        const service = su.get?.("service");
        const operations = su.get?.("operations");
        if (!service || !operations || !operations.items) continue;
        for (const opItem of operations.items) {
            const op = typeof opItem === "string" ? opItem : opItem.value;
            if (!op) continue;
            const ref = `${service}.${op}`;
            const cls = classifyOperation(serviceVocab, contractOps, service, op);
            if (cls.warning) warnings.push(cls.warning);
            if (cls.tier === "optional") {
                optional.push(ref);
            } else {
                required.push(ref);
            }
        }
    }

    return { required, optional, warnings };
}

// ---------------------------------------------------------------------------
// Main

function main() {
    const args = process.argv.slice(2);
    const writeMode = args.includes("--write");
    const files = args.filter((a) => !a.startsWith("--"));

    if (files.length === 0) {
        console.error("usage: migrate-tool-declarations.js [--write] <pack.yaml...>");
        process.exit(1);
    }

    const serviceVocab = loadServiceVocabulary();
    const contractOps = loadContractClassificationsESM();

    let totalSkills = 0;
    let totalSkipped = 0;
    let totalConverted = 0;
    let totalNoServicesUsed = 0;
    const allWarnings = [];

    for (const file of files) {
        const path = resolve(file);
        const raw = readFileSync(path, "utf8");
        const doc = parseDocument(raw, { keepSourceTokens: true });

        const skillsNode = doc.get("skills");
        if (!skillsNode || !skillsNode.items) {
            console.error(`[${file}] no 'skills' section — skipping`);
            continue;
        }

        const summary = {
            skipped: 0,
            no_services_used: 0,
        };
        let convertedInPack = 0;

        for (const skillNode of skillsNode.items) {
            totalSkills += 1;
            const result = convertSkill(skillNode, serviceVocab, contractOps, summary);
            if (!result) continue;

            const skillName = skillNode.get("name") ?? skillNode.get("import") ?? "<unnamed>";

            if (result.warnings.length) {
                for (const w of result.warnings) {
                    allWarnings.push(`[${file}] ${skillName}: ${w}`);
                }
            }

            if (writeMode) {
                if (result.required.length) skillNode.set("required_services", result.required);
                if (result.optional.length) skillNode.set("optional_services", result.optional);
                // DD-244 Q3 defaults — don't override if already set.
                if (!skillNode.has("allow_request_service")) {
                    skillNode.set("allow_request_service", true);
                }
                if (!skillNode.has("allow_request_tool")) {
                    skillNode.set("allow_request_tool", false);
                }
            }
            convertedInPack += 1;
            totalConverted += 1;
        }

        totalSkipped += summary.skipped;
        totalNoServicesUsed += summary.no_services_used;

        console.log(
            `[${file}] converted=${convertedInPack} skipped=${summary.skipped} no_services_used=${summary.no_services_used}`,
        );

        if (writeMode && convertedInPack > 0) {
            // Bump pack-format to "1.12" if it isn't already there.
            if (doc.get("pack") !== "1.12") {
                doc.set("pack", "1.12");
            }
            // Strict formatting flags to minimise cosmetic churn — preserve
            // line width, default to plain strings (no auto-quote), don't
            // expand unicode escape sequences.
            const output = doc.toString({
                lineWidth: 0,
                minContentWidth: 0,
                defaultStringType: "PLAIN",
                defaultKeyType: "PLAIN",
                doubleQuotedAsJSON: false,
                singleQuote: false,
            });
            writeFileSync(path, output);
        }
    }

    console.log("---");
    console.log(`Total skills inspected: ${totalSkills}`);
    console.log(`Converted: ${totalConverted}`);
    console.log(`Skipped (already v1.12): ${totalSkipped}`);
    console.log(`No services_used block: ${totalNoServicesUsed}`);

    if (allWarnings.length) {
        console.log("---");
        console.log(`Warnings (${allWarnings.length}):`);
        for (const w of allWarnings) console.log(`  ${w}`);
    }

    if (!writeMode) {
        console.log("---");
        console.log("DRY RUN — pass --write to mutate files.");
    }
}

main();
