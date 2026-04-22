/**
 * ACP Agent Capability Monitor
 *
 * Probes ACP agents defined in agents.json by spawning them, sending an
 * `initialize` JSON-RPC request, and capturing their capabilities response.
 * Also fetches upstream ACP schema definitions for drift detection.
 *
 * Results are written to snapshots/{id}.json. Git diff is the change-detection
 * mechanism — the GitHub Actions workflow commits any changes automatically.
 *
 * Usage:
 *   node script/check.mjs                  # probe all agents + schemas
 *   node script/check.mjs --agents-only    # probe agents only
 *   node script/check.mjs --schemas-only   # fetch schemas only
 *   node script/check.mjs --id <id>        # probe a single agent or schema by id
 */

import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SNAPSHOTS_DIR = resolve(ROOT, 'snapshots');
const CONFIG_PATH = resolve(ROOT, 'agents.json');
const ERRORS_FILE = process.env.PROBE_ERRORS_FILE ?? '/tmp/probe-errors.json';

// Collects probe/schema failures for this run. Written to ERRORS_FILE at the
// end so the GitHub Actions workflow can open/update a dedicated issue.
/** @type {Array<{id: string, name: string, type: 'agent'|'schema', message: string, command?: string, url?: string}>} */
const errors = [];

function recordError(entry) {
    errors.push(entry);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const agentsOnly = args.includes('--agents-only');
const schemasOnly = args.includes('--schemas-only');
const idFlagIndex = args.indexOf('--id');
const filterById = idFlagIndex !== -1 ? args[idFlagIndex + 1] : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the snapshots directory exists. */
function ensureSnapshotsDir() {
    if (!existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, {recursive: true});
    }
}

/**
 * Write a snapshot file with stable JSON formatting.
 * @param {string} id   Agent or schema identifier
 * @param {object} data Snapshot payload
 */
function writeSnapshot(id, data) {
    const filePath = resolve(SNAPSHOTS_DIR, `${id}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    console.log(`  ✓ Snapshot written: snapshots/${id}.json`);
}

/**
 * Build a JSON-RPC 2.0 request string.
 * @param {number} id      Request ID
 * @param {string} method  JSON-RPC method
 * @param {object} params  Method params
 * @returns {string} Newline-terminated JSON-RPC message
 */
function jsonRpcRequest(id, method, params) {
    return JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n';
}

// ---------------------------------------------------------------------------
// Agent probing
// ---------------------------------------------------------------------------

/**
 * Probe a single ACP agent by spawning it and sending `initialize`.
 *
 * @param {object} agent  Agent config from agents.json
 * @returns {Promise<void>}
 */
async function probeAgent(agent) {
    console.log(`\n🔍 Probing agent: ${agent.name} (${agent.id})`);
    console.log(`   Command: ${agent.spawn.command} ${agent.spawn.args.join(' ')}`);

    const timeout = agent.spawn.timeoutMs ?? 30_000;

    return new Promise((resolvePromise) => {
        let stdout = '';
        let resolved = false;
        let timer;

        const child = spawn(agent.spawn.command, agent.spawn.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            env: {
                ...process.env,
                // Strip auth tokens — initialize doesn't need them
                GH_TOKEN: undefined,
                GITHUB_TOKEN: undefined,
            },
        });

        const cleanup = (reason) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try {
                child.stdin?.end();
                child.kill('SIGTERM');
            } catch {
                // already dead
            }
        };

        const commandStr = `${agent.spawn.command} ${agent.spawn.args.join(' ')}`;

        // Timeout guard
        timer = setTimeout(() => {
            const msg = `Timeout after ${timeout}ms`;
            console.log(`  ✗ ${msg} — keeping previous snapshot`);
            recordError({id: agent.id, name: agent.name, type: 'agent', message: msg, command: commandStr});
            cleanup('timeout');
            resolvePromise();
        }, timeout);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();

            // Look for a complete JSON-RPC response line
            const lines = stdout.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    continue;
                }

                // Match the response to our request (id: 1)
                if (parsed.id === 1 && (parsed.result || parsed.error)) {
                    cleanup('got response');

                    if (parsed.error) {
                        const msg = `Agent returned error: ${parsed.error.message}`;
                        console.log(`  ✗ ${msg} — keeping previous snapshot`);
                        recordError({id: agent.id, name: agent.name, type: 'agent', message: msg, command: commandStr});
                    } else {
                        const result = parsed.result;
                        console.log(`  Agent: ${result.agentInfo?.name ?? 'unknown'} v${result.agentInfo?.version ?? '?'}`);
                        console.log(`  Protocol version: ${result.protocolVersion}`);

                        // Remove volatile _meta fields for stable snapshots
                        const snapshot = sanitize(result);

                        // Exclude agentInfo.version — it changes frequently
                        // and does not indicate a capability change.
                        const agentInfo = snapshot.agentInfo ? {...snapshot.agentInfo} : null;
                        if (agentInfo) {
                            delete agentInfo.version;
                        }

                        writeSnapshot(agent.id, {
                            agentInfo,
                            protocolVersion: snapshot.protocolVersion,
                            agentCapabilities: snapshot.agentCapabilities ?? {},
                            authMethods: snapshot.authMethods ?? [],
                        });
                    }

                    resolvePromise();
                    return;
                }
            }
        });

        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (err) => {
            const msg = `Failed to spawn: ${err.message}`;
            console.log(`  ✗ ${msg} — keeping previous snapshot`);
            recordError({id: agent.id, name: agent.name, type: 'agent', message: msg, command: commandStr});
            cleanup('spawn error');
            resolvePromise();
        });

        child.on('exit', (code, signal) => {
            if (!resolved) {
                const msg = `Process exited before responding (code=${code}, signal=${signal})`;
                const detail = stderr.trim() ? `${msg}: ${stderr.trim().split('\n').slice(-5).join(' | ')}` : msg;
                console.log(`  ✗ ${msg} — keeping previous snapshot`);
                recordError({id: agent.id, name: agent.name, type: 'agent', message: detail, command: commandStr});
                cleanup('premature exit');
                resolvePromise();
            }
        });

        // Send the initialize request
        const request = jsonRpcRequest(1, 'initialize', agent.initializeRequest);
        child.stdin.write(request);
    });
}

/**
 * Recursively remove `_meta` keys from an object for stable snapshots.
 * @param {any} obj
 * @returns {any}
 */
function sanitize(obj) {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sanitize);
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key === '_meta') continue;
        result[key] = sanitize(value);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Schema fetching
// ---------------------------------------------------------------------------

/**
 * Fetch and extract specific $defs from the upstream ACP JSON schema.
 *
 * @param {object} schemaConfig  Schema config from agents.json
 * @returns {Promise<void>}
 */
async function fetchSchema(schemaConfig) {
    console.log(`\n📋 Fetching schema: ${schemaConfig.name} (${schemaConfig.id})`);
    console.log(`   URL: ${schemaConfig.url}`);

    try {
        const response = await fetch(schemaConfig.url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const schema = await response.json();
        const defs = schema.$defs ?? schema.definitions ?? {};

        // Extract only the requested definitions
        const extracted = {};
        for (const defName of schemaConfig.extract) {
            if (defs[defName]) {
                extracted[defName] = sanitize(defs[defName]);
                console.log(`  ✓ Extracted: ${defName}`);
            } else {
                console.log(`  ⚠ Not found: ${defName}`);
                extracted[defName] = null;
            }
        }

        writeSnapshot(schemaConfig.id, {
            sourceUrl: schemaConfig.url,
            definitions: extracted,
        });
    } catch (err) {
        const msg = `Failed to fetch schema: ${err.message}`;
        console.log(`  ✗ ${msg} — keeping previous snapshot`);
        recordError({id: schemaConfig.id, name: schemaConfig.name, type: 'schema', message: msg, url: schemaConfig.url});
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('ACP Agent Capability Monitor');
    console.log('============================');

    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    ensureSnapshotsDir();

    const agents = config.agents ?? [];
    const schemas = config.schemas ?? [];

    // Probe agents
    if (!schemasOnly) {
        const toProbe = filterById ? agents.filter((a) => a.id === filterById) : agents;
        for (const agent of toProbe) {
            await probeAgent(agent);
        }
    }

    // Fetch schemas
    if (!agentsOnly) {
        const toFetch = filterById ? schemas.filter((s) => s.id === filterById) : schemas;
        for (const schema of toFetch) {
            await fetchSchema(schema);
        }
    }

    // Emit an error artifact for the workflow (always write it so downstream
    // steps can read a stable path; empty list means "no errors this run").
    try {
        writeFileSync(
            ERRORS_FILE,
            JSON.stringify({generatedAt: new Date().toISOString(), errors}, null, 2) + '\n',
            'utf-8',
        );
        if (errors.length > 0) {
            console.log(`\n⚠ ${errors.length} probe error(s) recorded → ${ERRORS_FILE}`);
        }
    } catch (err) {
        console.log(`\n⚠ Could not write errors file (${ERRORS_FILE}): ${err.message}`);
    }

    console.log('\n✅ Done.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
});
