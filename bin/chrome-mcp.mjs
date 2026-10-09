#!/usr/bin/env node
/**
 * dsh-codex-chrome — MCP stdio server.
 *
 * DSH starts this process through `@deepseek-ai/dsh-mcp-client` (serverName
 * `chrome`). It publishes the tool surface defined in `lib/tools.mjs` and, on
 * first use, spawns the Codex `node_repl` kernel that hosts the vendor browser
 * service.
 *
 * stdout carries the MCP wire protocol only; every diagnostic goes to stderr, so
 * a chatty runtime can never corrupt a frame.
 *
 * @module dsh-codex-chrome/launcher
 */

import { fileURLToPath } from 'node:url';
import { NodeReplBridge } from '../lib/node-repl.mjs';
import { nodeReplEnv, resolveRuntime } from '../lib/paths.mjs';
import { SERVER_INSTRUCTIONS, TOOL_DEFINITIONS, executeTool } from '../lib/tools.mjs';

/** Protocol revisions this server can speak. */
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_PROTOCOL = '2025-06-18';
const SERVER_NAME = 'dsh-codex-chrome';
const SERVER_VERSION = '0.1.0';

const HELPER_PATH = fileURLToPath(new URL('../lib/browser-session.mjs', import.meta.url));

const log = (...parts) => {
  process.stderr.write(`[dsh-codex-chrome] ${parts.join(' ')}\n`);
};

let runtime = null;
/** @type {NodeReplBridge|null} */
let bridge = null;
let shuttingDown = false;

function getRuntime() {
  if (runtime === null) {
    runtime = resolveRuntime(process.env);
    for (const problem of runtime.problems) log(`warning: ${problem}`);
    log(`codex home: ${runtime.codexHome}`);
    log(`browser client: ${runtime.browserClientPath ?? '<missing>'}`);
    log(`browser service: ${runtime.browserServicePath ?? '<missing>'}`);
    log(`node_repl: ${runtime.nodeReplPath ?? '<missing>'}`);
  }
  return runtime;
}

/** Lazily (re)start the Codex kernel. */
async function getBridge() {
  const resolved = getRuntime();
  if (resolved.nodeReplPath === null) {
    throw new Error(
      `Codex node_repl runtime not found. Tried: ${resolved.nodeReplCandidates.slice(0, 4).join(', ')}. ` +
        'Set DSH_CODEX_CHROME_NODE_REPL to its absolute path.',
    );
  }
  if (bridge === null) {
    bridge = new NodeReplBridge({
      command: resolved.nodeReplPath,
      args: [],
      env: nodeReplEnv(resolved),
      cwd: resolved.codexHome,
    });
  }
  await bridge.start();
  return bridge;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
      log(`initialize: client=${params?.clientInfo?.name ?? '?'} protocol=${requested ?? '?'} -> ${protocolVersion}`);
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return;
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOL_DEFINITIONS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== 'string' || name.length === 0) {
        replyError(id, -32602, 'tools/call requires a tool name');
        return;
      }
      if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
        reply(id, { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true });
        return;
      }
      try {
        const instance = await getBridge();
        const result = await executeTool(instance, { helperPath: HELPER_PATH, browserClientPath: getRuntime().browserClientPath }, name, args);
        reply(id, result);
      } catch (error) {
        log(`tool ${name} failed: ${error?.stack ?? error}`);
        reply(id, {
          content: [{ type: 'text', text: `dsh-codex-chrome: ${String(error?.message ?? error)}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (bridge !== null) await bridge.stop();
  } catch {
    /* best effort */
  }
  process.exit(code);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log('dropping malformed frame');
      continue;
    }
    Promise.resolve(handle(message)).catch((error) => log(`handler error: ${error?.stack ?? error}`));
  }
});
process.stdin.on('end', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack ?? error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error?.stack ?? error}`));

log(`listening (pid ${process.pid}) with ${TOOL_DEFINITIONS.length} tools`);
