#!/usr/bin/env node
/**
 * dsh-codex-chrome — live smoke test.
 *
 * Spawns the MCP server exactly as DSH does, drives a real browser, and asserts
 * the whole chain works: node_repl kernel → trusted browser service → ChatGPT
 * browser extension → Chrome.
 *
 * Usage: node scripts/smoke.mjs [--url https://example.com/] [--keep]
 *
 * It opens a tab in the user's browser, exercises it, and closes it again
 * unless `--keep` is passed.
 *
 * @module dsh-codex-chrome/smoke
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const urlIndex = args.indexOf('--url');
const target = urlIndex >= 0 ? args[urlIndex + 1] : 'https://example.com/';

const launcher = fileURLToPath(new URL('../bin/chrome-mcp.mjs', import.meta.url));

const child = spawn(process.execPath, [launcher], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const lineText = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (lineText.length === 0) continue;
    let message;
    try {
      message = JSON.parse(lineText);
    } catch {
      continue;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) continue;
    pending.delete(message.id);
    entry(message);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));

const call = (id, method, params) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const tool = async (id, name, toolArgs = {}) => {
  const response = await call(id, 'tools/call', { name, arguments: toolArgs });
  const content = response.result?.content ?? [];
  const text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  const images = content.filter((item) => item.type === 'image').length;
  return { text, images, isError: response.result?.isError === true, raw: response };
};

let failures = 0;
const check = (label, condition, detail = '') => {
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!condition) failures += 1;
};

const finish = async (code) => {
  if (!keep) {
    try {
      await tool(900, 'chrome_tabs', { action: 'close' });
    } catch {
      /* best effort */
    }
  }
  try {
    await tool(901, 'chrome_end_turn', {});
  } catch {
    /* best effort */
  }
  child.kill('SIGTERM');
  process.exit(code);
};

try {
  const init = await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0.1.0' } });
  check('initialize', typeof init.result?.serverInfo?.name === 'string', init.result?.serverInfo?.name);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await call(2, 'tools/list', {});
  const names = (list.result?.tools ?? []).map((entry) => entry.name);
  check('tools/list', names.length === 11, `${names.length} tools: ${names.join(', ')}`);

  const status = await tool(3, 'chrome_status');
  const statusValue = status.text.startsWith('{') ? JSON.parse(status.text.split('\n\n')[0]) : null;
  check('chrome_status reaches the runtime', statusValue?.ok === true, statusValue === null ? status.text.slice(0, 200) : '');
  const browsers = statusValue?.browsers ?? [];
  check('a browser is connected', browsers.length > 0, browsers.map((b) => `${b.name}(${b.type})`).join(', '));
  if (browsers.length === 0) await finish(1);

  const open = await tool(4, 'chrome_tabs', { action: 'new', url: target });
  const openValue = JSON.parse(open.text);
  check(`open ${target}`, openValue.ok === true && typeof openValue.tab?.tabId === 'string', openValue.tab?.title ?? open.text.slice(0, 200));
  if (openValue.ok !== true) await finish(1);

  const observed = await tool(5, 'chrome_observe', { mode: 'state', maxChars: 4000, disableDiffing: true });
  const observedValue = JSON.parse(observed.text);
  check('observe returns an accessibility tree', typeof observedValue.state === 'string' && observedValue.state.length > 0, `${observedValue.state?.length ?? 0} chars`);
  check('observe reports title and url', typeof observedValue.url === 'string' && observedValue.url.length > 0, observedValue.url);

  const dom = await tool(6, 'chrome_observe', { mode: 'dom', maxChars: 2000 });
  const domValue = JSON.parse(dom.text);
  check('dom snapshot', typeof domValue.dom === 'string' && domValue.dom.length > 0, `${domValue.dom?.length ?? 0} chars`);

  const shot = await tool(7, 'chrome_observe', { mode: 'screenshot' });
  const shotValue = JSON.parse(shot.text.split('\n\n')[0]);
  check('screenshot', shotValue.image?.bytes > 0, `${shotValue.image?.bytes ?? 0} bytes, ${shot.images} image block(s)`);
  check('screenshot spooled to disk', /Screenshot saved to /.test(shot.text), shot.text.split('\n\n').at(-1)?.slice(0, 120));

  const evaluated = await tool(8, 'chrome_evaluate', { expression: 'document.title' });
  const evaluatedValue = JSON.parse(evaluated.text);
  check('page evaluate', evaluatedValue.ok === true && typeof evaluatedValue.value === 'string', evaluatedValue.value);

  const escape = await tool(9, 'chrome_js', { code: 'return { links: await tab.playwright.evaluate("document.links.length"), title: await tab.title() };' });
  const escapeValue = JSON.parse(escape.text);
  check('chrome_js escape hatch', escapeValue.ok === true, JSON.stringify(escapeValue.value ?? escapeValue.error));

  const back = await tool(10, 'chrome_navigate', { action: 'reload' });
  check('reload', JSON.parse(back.text).ok === true);
} catch (error) {
  check('smoke run', false, String(error?.stack ?? error));
}

process.stdout.write(`\n${failures === 0 ? 'smoke: PASS' : `smoke: FAIL (${failures})`}\n`);
await finish(failures === 0 ? 0 : 1);
