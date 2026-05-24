# DD-338 Marketplace Refresh Runbook

After running `stallari-conformance verify --live` (Phase D.2) and
`tier_issuance.py --apply` (Phase D.3) to flip tool declarations, the
marketplace tile state is refreshed via this five-step chain.

The script `scripts/dd-338-refresh-catalog.mjs` is a thin orchestrator: it
wraps the existing `scripts/build-catalog.js`, snapshots the prior
`dist/catalog.json`, regenerates the catalog, computes a structured diff,
and emits `dist/dd-338-refresh-summary.json` for review.

## Chain

### 1. Regenerate the catalog

From the `stallari-plugins/` repo root:

```bash
node scripts/dd-338-refresh-catalog.mjs
```

This will:

1. Move any existing `dist/catalog.json` to `dist/catalog.json.prev` (the
   diff baseline).
2. Run `node scripts/build-catalog.js`, which regenerates
   `dist/catalog.json`, `dist/services.json`, `dist/add-ons.json`,
   `dist/pack-details.json`, and per-pack manifests under
   `dist/packs/<slug>/<version>/manifest.json`. AJV schema validation
   (DD-333 Phase A.1) + cross-field gates (DD-333 F.1 + F.4) run as part
   of `build-catalog.js`. If anything fails the chain exits non-zero and
   the prior catalog snapshot is preserved at `dist/catalog.json.prev`.
3. Compute a structured diff between prev and new and write
   `dist/dd-338-refresh-summary.json`.
4. Print a brief human-readable summary to stdout.

**First-run behaviour:** when there is no prior `dist/catalog.json` the
script treats the run as a baseline. The summary reports every entry as
an addition and notes that no diff was computed.

### 2. Review the diff

Open `dist/dd-338-refresh-summary.json`. The shape is:

```json
{
  "generated": "2026-05-24T03:14:15.000Z",
  "dd": "DD-338",
  "phase": "D.5",
  "catalog_meta": { "version": "1.1.0", "generated": "2026-05-24", "total": 73, "plugins": 65, "packs": 8 },
  "diff": {
    "baseline": false,
    "added":   ["..."],
    "removed": ["..."],
    "changed": [
      {
        "name": "cloudflare-blade",
        "type": "plugin",
        "tier_change": null,
        "readiness_change": null,
        "tool_changes": [
          { "tool": "cf_d1_query", "field": "deterministic_ordering", "before": "unstable", "after": "stable" }
        ]
      }
    ],
    "summary": { "added": 0, "removed": 0, "changed": 1, "tool_flips_total": 1 }
  }
}
```

Per-tool granularity flips should match the proposals D.3 generated. If
they do not, investigate — something edited `plugins/tools/*.json` between
the D.3 `--apply` and this refresh.

Diff axes tracked per tool: `scope_filtering`, `field_projection`,
`deterministic_ordering`, `audit_surface`, `domain_scope`, plus
`presence` (tools added or removed from a catalog entry). Entry-level
changes track `tier` and `readiness`.

### 3. Commit and push

The regenerated `dist/catalog.json` is **gitignored** — it is rebuilt by
CI on every push to `main`. What you commit is the source change in
`plugins/tools/*.json` (the D.3 `--apply` output). The downstream
`stallari-registry-infra` deploy workflow picks up the catalog on next
push to `main`, or you can manually `wrangler deploy` from the
registry-infra repo.

If `dist/dd-338-refresh-summary.json` is useful as a review artefact for
a PR description, paste the `diff.summary` block + `changed[]` rows into
the PR body — do **not** commit the summary file itself (it sits inside
the gitignored `dist/`).

### 4. Daemon refresh

Running Stallari daemons poll the registry HTTP endpoint at a
configurable interval (default 5 min per `RegistryClient` config).
Force-refresh via the daemon CLI:

```bash
stallari-cli registry refresh
```

### 5. Verify

Restart the Stallari app OR wait for the next refresh tick. Marketplace
tile badges should reflect the new tier state. Cross-check a known
flipped tool against the in-app marketplace surface and confirm the
declared granularity row matches the summary.

## Failure modes

| Symptom | Cause | Resolution |
|---|---|---|
| `scripts/build-catalog.js exited with code 1` | Schema validation or cross-field gate failed | Stderr from build-catalog includes the offending entry + field; fix the source `plugins/tools/<name>.json` |
| Empty diff after D.3 `--apply` | Source files not actually changed | Re-run `tier_issuance.py --apply` and confirm git status shows mutations in `plugins/tools/` |
| Summary missing | Build-catalog failed mid-run | `dist/catalog.json.prev` is preserved as the baseline; rerun the wrapper after fixing the source |
| Daemon still shows old badges after `stallari-cli registry refresh` | Cloudflare Worker cache or R2 not yet redeployed | Check the `stallari-registry-infra` deploy workflow; the catalog is fronted by a CF Worker that has its own deploy cadence |

## Related

- [[DD-338]] Phase D § "D.5 marketplace tile state refresh"
- Phase D.2 — `stallari-conformance verify --live`
- Phase D.3 — `tier_issuance.py --apply`
- `scripts/build-catalog.js` — the existing catalog builder this script wraps
- `stallari-registry-infra/` — out-of-scope cross-repo deploy pipeline that ultimately serves `dist/catalog.json` to running daemons
