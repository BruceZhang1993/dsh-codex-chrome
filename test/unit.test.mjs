/**
 * Unit tests for the pure pieces: runtime discovery, the MCP result framing,
 * the tool catalog contract, and the skill document.
 *
 * These run without a browser, a ChatGPT installation, or DSH.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { codexHome, nodeReplEnv, resolvePlugin, resolveRuntime } from '../lib/paths.mjs';
import { RESULT_MARKER, TOOL_DEFINITIONS, parseResult, sniffMimeType } from '../lib/tools.mjs';
import { BUNDLED_SKILL_NAME, loadBundledSkill, parseSkillDocument } from '../lib/skill.mjs';

test('codexHome honours CODEX_HOME and falls back to ~/.codex', () => {
  assert.equal(codexHome({ CODEX_HOME: '/tmp/example-codex' }), '/tmp/example-codex');
  assert.match(codexHome({}), /\.codex$/);
});

test('resolvePlugin returns candidates and never invents a root', () => {
  const result = resolvePlugin('definitely-not-a-plugin', { CODEX_HOME: '/tmp/does-not-exist' });
  assert.equal(result.root, null);
  assert.equal(result.version, null);
  assert.ok(result.candidates.length > 0);
});

test('resolveRuntime reports actionable problems when the Codex assets are absent', () => {
  const runtime = resolveRuntime({ CODEX_HOME: '/tmp/does-not-exist-anywhere', PATH: '/usr/bin' });
  assert.equal(runtime.chrome.root, null);
  assert.equal(runtime.browser.root, null);
  assert.equal(runtime.browserClientPath, null);
  assert.equal(runtime.browserServicePath, null);
  assert.ok(runtime.problems.length >= 2);
  assert.ok(runtime.problems.some((problem) => problem.includes('chrome plugin')));
  assert.ok(runtime.problems.some((problem) => problem.includes('browser plugin')));
  // node_repl is discovered independently of CODEX_HOME, so it must not be
  // reported as a problem just because the plugin cache is unreachable.
  assert.ok(runtime.nodeReplCandidates.length > 0);
});

test('nodeReplEnv wires the trusted browser service and the sandbox code paths', () => {
  const runtime = {
    codexHome: '/home/example/.codex',
    chrome: { root: '/plugins/chrome/latest', version: '1.2.3', candidates: [] },
    browser: { root: '/plugins/browser/latest', version: '1.2.3', candidates: [] },
    browserClientPath: '/plugins/chrome/latest/scripts/browser-client.mjs',
    browserServicePath: '/plugins/browser/latest/scripts/browser-service.mjs',
    nodeReplPath: '/opt/cua/node_repl',
    nodeReplCandidates: [],
    codexCliPath: '/opt/codex',
    problems: [],
  };
  const env = nodeReplEnv(runtime, { PATH: '/usr/bin', HOME: '/home/example' });
  assert.equal(env.CODEX_HOME, '/home/example/.codex');
  assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), { browser: '/plugins/browser/latest/scripts/browser-service.mjs' });
  assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, '1.2.3');
  assert.equal(env.CODEX_CLI_PATH, '/opt/codex');
  assert.equal(env.PATH, '/usr/bin');
  const trusted = env.NODE_REPL_TRUSTED_CODE_PATHS.split(':');
  assert.ok(trusted.includes('/home/example/.codex'), 'CODEX_HOME must be importable inside the sandbox');
  assert.ok(trusted.some((entry) => entry.endsWith('dsh-codex-chrome')), 'this package root must be importable inside the sandbox');
  // node_repl has no sibling runtime here, so no module dirs are guessed.
  assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, undefined);
});

test('parseResult reads the payload after the last marker', () => {
  const text = `noise\n${RESULT_MARKER}{"ok":false,"error":{"message":"first"}}\n${RESULT_MARKER}{"ok":true,"tabId":"7"}`;
  assert.deepEqual(parseResult(text), { ok: true, tabId: '7' });
});

test('parseResult surfaces a protocol failure instead of throwing', () => {
  const parsed = parseResult('the kernel printed nothing useful');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'bridge_protocol');
});

test('sniffMimeType trusts magic bytes over the declared label', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]).toString('base64');
  // The vendor capture path declares PNG but emits JPEG; the payload must win.
  assert.equal(sniffMimeType({ data: jpeg, mimeType: 'image/png' }), 'image/jpeg');
  assert.equal(sniffMimeType({ data: png, mimeType: 'image/png' }), 'image/png');
  assert.equal(sniffMimeType({ data: webp, mimeType: 'image/png' }), 'image/webp');
  assert.equal(sniffMimeType({ data: 'bm90YW5pbWFnZQ==', mimeType: 'image/gif' }), 'image/gif');
});

test('tool catalog is unique, namespaced and documented', () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of TOOL_DEFINITIONS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} must be a plain snake_case name`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    // Every required key must be declared.
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(required in tool.inputSchema.properties, `${tool.name} requires undeclared property ${required}`);
    }
  }
  assert.ok(names.includes('chrome_status'));
  assert.ok(names.includes('chrome_end_turn'));
});

test('skill document parses and matches the registered name', () => {
  const skill = loadBundledSkill();
  assert.equal(skill.name, BUNDLED_SKILL_NAME);
  assert.ok(skill.description.length > 0);
  assert.ok(skill.content.includes('chrome_observe'), 'the skill must document the observation tool');
  assert.ok(skill.content.includes('chrome_end_turn'), 'the skill must document turn hygiene');
  assert.equal(skill.invocation.modelInvocable, true);
});

test('skill parser rejects a document without frontmatter', () => {
  assert.throws(() => parseSkillDocument('# no frontmatter here'), /frontmatter/);
});

test('the bundle patch mounts the MCP bridge and the plugin entry', () => {
  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8');
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, /serverName: chrome/);
  assert.match(patch, /resolve\('dsh-codex-chrome\/launcher'\)/);
  assert.match(patch, /name: 'dsh-codex-chrome'/);
});

test('package manifest exposes the launcher and the session helper', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(pkg.name, 'dsh-codex-chrome');
  assert.equal(pkg.exports['./launcher'], './bin/chrome-mcp.mjs');
  assert.equal(pkg.exports['./session'], './lib/browser-session.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});
