<p align="center">
  <a href="https://marketplace.stallari.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/stallari-logo-dark.png">
      <img src="assets/stallari-logo-light.png" alt="Stallari" width="320">
    </picture>
  </a>
</p>

<h1 align="center">Stallari Plugins</h1>

<p align="center">
  <a href="https://marketplace.stallari.app"><img src="https://img.shields.io/badge/marketplace-stallari.app-0066CC" alt="marketplace.stallari.app"></a>
  <a href="https://github.com/Groupthink-dev/stallari-plugins/discussions"><img src="https://img.shields.io/github/discussions/Groupthink-dev/stallari-plugins?label=discussions" alt="Discussions"></a>
  <img src="https://img.shields.io/badge/status-developer%20preview-orange" alt="Developer Preview">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="Apache 2.0">
</p>

Plugin and pack manifests for the [Stallari](https://stallari.ai) agentic platform. Service contract definitions, validation tooling, and contribution workflow.

## Overview

This repository manages two types of entries:

- **Plugins** (MCP tools) — JSON manifests in `plugins/tools/` declaring Model Context Protocol servers that implement service contracts.
- **Packs** (workflow bundles) — YAML manifests in `plugins/packs/` defining multi-agent skills, workflows, and automation pipelines.

Both are distributed through the [Stallari Marketplace](https://marketplace.stallari.app).

## Service Contracts

Plugins implement versioned **service contracts** — abstract interfaces that let the platform swap providers without changing workflows. Contracts live in `schemas/contracts/` and define required, recommended, optional, and gated operations.

| Contract | Operations | Example Plugins |
|----------|------------|-----------------|
| `email-v1` | 13 | fastmail-blade-mcp, gmail-blade-mcp |
| `calendar-v1` | 8 | caldav-blade-mcp, google-calendar-mcp |
| `tasks-v1` | 11 | things3-blade-mcp, todoist-blade-mcp |
| `vault-v1` | 25 | stallari-blade-mcp |
| `billing-v1` | 28 | paddle-billing-blade-mcp |
| `accounting-v1` | 39 | xero-blade-mcp |
| `ecommerce-v1` | 40 | shopify-blade-mcp |
| `file-storage-v1` | 14 | onedrive-blade-mcp |
| `protective-dns-v1` | 22 | controld-blade-mcp, adguard-home-mcp |
| `dns-authoritative-v1` | 13 | cloudflare-blade-mcp, vultr-blade-mcp |
| `kv-v1` | 7 | cloudflare-blade-mcp |
| `functions-v1` | 14 | cloudflare-blade-mcp |
| `object-storage-v1` | 15 | cloudflare-blade-mcp |
| `notifications-v1` | — | resend-blade-mcp |

## Trust Tiers

Every plugin is classified into a trust tier:

| Tier | Meaning |
|------|---------|
| **Certified** | First-party, full conformance testing |
| **Verified** | Third-party, validated by maintainers |
| **Community** | Interest signal, untested conformance |

## Pack Spec

Packs follow the [Pack Spec](schemas/stallari-pack.schema.json) (v1.0–v1.7). A pack declares agents, skills, workflows, service dependencies, data access, guardrails, and user-configurable inputs.

```yaml
pack: "1.7"
name: daily-operations
version: "1.0.0"
description: Daily vault operations — digest, inbox processing, and email triage.

requires:
  services:
    - service: email
      operations: [search, read, snippets]
    - service: vault
      operations: [read, search, files]

data:
  reads: [email, calendar, tasks, vault]
  writes: [vault, tasks]
  stores: nothing
  phones_home: false

agents:
  - name: pkm-operator
    role: operator

skills:
  - name: daily-digest
    agent: pkm-operator
    description: Generate a morning digest
    # ...

guardrails:
  version: "1.0.0"
  reviewed: "2026-04-18"
  rules:
    - id: vault-001
      category: vault
      severity: critical
      scope: [community, verified]
      added: "2026-04-18"
```

### Key schema additions (v1.5–v1.7)

| Version | Additions |
|---------|-----------|
| v1.5 | Capability declarations, deployment class, model requirements |
| v1.6 | Tool groups, discovery profiles, client profile enforcement |
| v1.7 | Guardrails (sealed rule delivery), herald (announcements), agent `role` enum constraint |

Packs can be **open** (source visible, forkable) or **sealed** (encrypted payload, license-activated).

## Contributing

### Adding a plugin

1. **Fork this repo** and create a branch.

2. **Add a JSON manifest** in `plugins/tools/` named `your-plugin.json`. At minimum:

    ```json
    {
      "name": "your-plugin",
      "version": "1.0.0",
      "description": "What your MCP server does (max 200 chars)",
      "author": "your-github-handle",
      "license": "MIT",
      "tier": "community",
      "contract": null,
      "repository": "https://github.com/you/your-plugin",
      "install": {
        "runtime": "uv",
        "package": "your-plugin"
      }
    }
    ```

    Set `contract` to a contract ID (e.g. `"email-v1"`) if your plugin implements one, or `null` if it doesn't map to an existing service domain. See `schemas/contracts/` for available contracts.

3. **Run validation** (optional but recommended):

    ```bash
    npm ci
    make validate
    node scripts/validate-plugin.js plugins/tools/your-plugin.json --update
    ```

    The `--update` flag writes a `certification` block into your manifest with checklist results.

4. **Open a pull request.** CI validates the manifest and runs conformance checks automatically.

### Adding a pack

1. Create a YAML manifest in `plugins/packs/` following the [Pack Spec schema](schemas/stallari-pack.schema.json).
2. Validate locally: `make validate-packs`
3. Open a pull request.

### Validation checklist

The `validate-plugin.js` script runs automated checks:

| Check | Automated | Notes |
|-------|-----------|-------|
| Schema fields present | Yes | Required: name, version, description, author, license, tier, install |
| License compatible | Yes | MIT, Apache-2.0, ISC, BSD, Unlicense |
| Installs cleanly | Yes | Spawns via declared runtime |
| Tools enumerate | Yes | Sends MCP `tools/list` over stdio JSON-RPC |
| Tools callable | Manual | Requires service-specific credentials |
| No data exfiltration | Manual | Network traffic review |
| Auth reviewed | Manual | Authentication model documented |

### Trust tiers and promotion

All external submissions enter at `tier: "community"`. Promotion path:

- **Community** — listed in marketplace, conformance untested
- **Verified** — maintainers have validated the plugin (install, enumeration, license, security review)
- **Certified** — first-party plugins with full conformance testing against a service contract

### Sidecar manifest

If you'd like your plugin to participate in service routing (so packs can reference abstract operations like `{{email.search}}` and have them resolve to your tool), add a `stallari-plugin.yaml` to your repo root with a `services` block:

```yaml
services:
  email:
    search: my_search_tool
    read: my_read_tool
    # maps contract operations → your MCP tool names
```

See the [plugin schema](schemas/stallari-plugin.schema.json) for the full spec.

## Private Packs

Sealed packs (proprietary, encrypted prompts) live in a separate private
repository. The build tooling supports merging them via the
`PRIVATE_PACKS_DIR` environment variable:

```bash
PRIVATE_PACKS_DIR=path/to/sealed/packs make build-api
```

When set, the build scripts read pre-sealed artifacts from the specified
directory and merge them into the catalog alongside open packs. Sealing is a
client-side operation — the CI pipeline only verifies sealed pack integrity.

## Local Development

```bash
npm ci                    # Install deps (yaml parser)
make validate-all         # Validate plugin + pack manifests
make build-api            # Build catalog (plugins/ → dist/)
make test                 # Run build-script tests
make contracts            # List contracts with operation counts
```

## Community

Questions, ideas, and show-and-tell — [join the conversation on Discussions](https://github.com/Groupthink-dev/stallari-plugins/discussions).

## Licence

[Apache 2.0](LICENSE) — use freely with attribution.
