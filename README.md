# ACP Agent Capability Monitor

Automated daily monitor that detects changes to ACP (Agent Client Protocol) agent capabilities.

## How It Works

1. **Probes agents** — spawns each ACP agent defined in `agents.json`, sends an unauthenticated `initialize` JSON-RPC request, and captures the response
2. **Fetches schemas** — downloads the upstream ACP protocol schema and extracts capability definitions
3. **Writes snapshots** — saves results to `snapshots/{id}.json`
4. **Git detects changes** — the GitHub Actions workflow auto-commits any snapshot changes; `git log` is the changelog

## Quick Start

```bash
# Run locally
node script/check.mjs

# Probe a specific agent
node script/check.mjs --id github-copilot-cli

# Only probe agents (skip schema fetch)
node script/check.mjs --agents-only

# Only fetch schemas (skip agent probing)
node script/check.mjs --schemas-only
```

## Adding a New Agent

Add an entry to `agents.json`:

```json
{
  "id": "my-agent",
  "name": "My ACP Agent",
  "spawn": {
    "command": "npx",
    "args": ["-y", "my-agent-package", "--acp", "--stdio"],
    "timeoutMs": 30000
  },
  "initializeRequest": {
    "protocolVersion": 1,
    "clientCapabilities": {}
  }
}
```

Supported spawn methods:

| Runtime | Example command | Example args |
|---------|----------------|--------------|
| npx     | `npx`          | `["-y", "@github/copilot", "--acp", "--stdio"]` |
| uvx     | `uvx`          | `["my-python-agent", "--acp", "--stdio"]` |
| Binary  | `./my-agent`   | `["--acp", "--stdio"]` |

## Adding a Schema to Monitor

Add to the `schemas` array in `agents.json`:

```json
{
  "id": "acp-spec-schema",
  "name": "ACP Protocol Schema",
  "url": "https://raw.githubusercontent.com/.../schema.json",
  "extract": ["AgentCapabilities", "PromptCapabilities"]
}
```

## Project Structure

```
acp-agent-monitor/
├── .github/workflows/monitor.yml   # Daily cron + manual trigger
├── agents.json                     # Agent & schema configuration
├── snapshots/                      # Auto-committed capability snapshots
│   ├── github-copilot-cli.json
│   └── acp-spec-schema.json
├── script/
│   └── check.mjs                   # Monitoring script
├── package.json
└── README.md
```

## Viewing Change History

```bash
# All changes
git log --oneline -- snapshots/

# Changes for a specific agent
git log -p -- snapshots/github-copilot-cli.json
```
