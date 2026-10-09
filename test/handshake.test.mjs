/**
 * Integration test for the MCP server itself.
 *
 * It spawns `bin/chrome-mcp.mjs` exactly as DSH does and speaks the wire
 * protocol over stdio. Nothing here needs a browser, Codex, or DSH, so it runs
 * unchanged on a CI runner:
 *
 *   - the handshake negotiates and advertises the tool capability;
 *   - `tools/list` returns the documented catalog with valid schemas;
 *   - an unknown tool is rejected without ever starting the browser runtime;
 *   - a real tool call either succeeds or comes back as a *structured* error
 *     result — it must never crash the server or corrupt the stream;
 *   - closing stdin shuts the server down cleanly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../bin/chrome-mcp.mjs', import.meta.url));

/** Minimal MCP stdio client used by these tests. */
function connect() {
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const stderr = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry === undefined) continue;
      pending.delete(message.id);
      entry(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  return { child, send, notify, stderr: () => stderr.join('') };
}

test('MCP handshake, tool catalog, error handling and shutdown', async (t) => {
  const client = connect();
  t.after(() => {
    client.child.kill('SIGKILL');
  });

  const init = await client.send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ci-handshake', version: '1.0.0' },
  });
  assert.equal(init.result?.serverInfo?.name, 'dsh-codex-chrome');
  assert.ok(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'].includes(init.result?.protocolVersion));
  assert.ok(init.result?.capabilities?.tools, 'the server must advertise the tools capability');
  assert.match(init.result?.instructions ?? '', /chrome_status/);
  client.notify('notifications/initialized');

  const list = await client.send('tools/list', {});
  const tools = list.result?.tools ?? [];
  assert.equal(tools.length, 11);
  for (const tool of tools) {
    assert.match(tool.name, /^chrome_[a-z_]+$/);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
  }
  assert.ok(tools.some((tool) => tool.name === 'chrome_observe'));

  const ping = await client.send('ping', {});
  assert.deepEqual(ping.result, {});

  const unknown = await client.send('tools/call', { name: 'chrome_nope', arguments: {} });
  assert.equal(unknown.result?.isError, true);
  assert.match(unknown.result?.content?.[0]?.text ?? '', /unknown tool/);

  // A real call must degrade into a structured result, never a crash: on a
  // machine without Codex it reports the missing runtime; on a developer
  // machine it reports the connected browsers. Both are valid here.
  const status = await client.send('tools/call', { name: 'chrome_status', arguments: {} });
  assert.ok(Array.isArray(status.result?.content), 'a tool call must return content blocks');
  const text = status.result.content.map((item) => item.text ?? '').join('\n');
  assert.ok(text.length > 0, 'a tool call must return some text');
  if (status.result.isError === true) {
    assert.doesNotMatch(text, /Error: /, 'a failure must be reported as a value, not a thrown stack');
  } else {
    const value = JSON.parse(text);
    assert.equal(value.ok, true);
    assert.ok(Array.isArray(value.browsers));
  }

  // Closing stdin ends the session without a stray exit code or a partial frame.
  client.child.stdin.end();
  const [code] = await once(client.child, 'exit');
  assert.equal(code, 0, `server exited with ${code}; stderr:\n${client.stderr()}`);
});
