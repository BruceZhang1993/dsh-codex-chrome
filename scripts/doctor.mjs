#!/usr/bin/env node
/**
 * dsh-codex-chrome — environment doctor.
 *
 * Answers "why can Chrome not be driven from here?" without starting DSH:
 * where the Codex assets are, whether the ChatGPT browser extension and its
 * native messaging host are installed, and whether the browser service actually
 * reports a connected browser.
 *
 * Usage: node scripts/doctor.mjs [--deep]
 *   --deep  also spawn the MCP bridge and ask it for chrome_status
 *
 * @module dsh-codex-chrome/doctor
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeReplBridge } from '../lib/node-repl.mjs';
import { nodeReplEnv, resolveRuntime } from '../lib/paths.mjs';
import { executeTool } from '../lib/tools.mjs';

const deep = process.argv.includes('--deep');

const OK = 'ok  ';
const BAD = 'FAIL';
const WARN = 'warn';

function line(status, label, detail = '') {
  process.stdout.write(`${status}  ${label}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const runtime = resolveRuntime(process.env);

process.stdout.write('dsh-codex-chrome doctor\n');
process.stdout.write('=======================\n\n');

line(OK, 'node', process.version);
line(OK, 'codex home', runtime.codexHome);
line(existsSync(runtime.chrome.root ?? '') ? OK : BAD, 'chrome plugin', runtime.chrome.root ?? `missing (tried ${runtime.chrome.candidates.join(', ')})`);
line(existsSync(runtime.browser.root ?? '') ? OK : BAD, 'browser plugin', runtime.browser.root ?? `missing (tried ${runtime.browser.candidates.join(', ')})`);
line(existsSync(runtime.browserClientPath ?? '') ? OK : BAD, 'browser-client.mjs', runtime.browserClientPath ?? 'missing');
line(existsSync(runtime.browserServicePath ?? '') ? OK : BAD, 'browser-service.mjs', runtime.browserServicePath ?? 'missing');
line(runtime.nodeReplPath === null ? BAD : OK, 'node_repl runtime', runtime.nodeReplPath ?? `missing (tried ${runtime.nodeReplCandidates.slice(0, 4).join(', ')})`);
line(runtime.codexCliPath === null ? WARN : OK, 'codex CLI', runtime.codexCliPath ?? 'not found (optional)');

process.stdout.write('\nBrowser extension\n-----------------\n');
let manifestFound = false;
let extensionFound = false;
const hostName = 'com.openai.codexextension';
const extensionId = 'hehggadaopoacecdllhhajmbjkdcmajg';
const browserHomes = [
  [join(homedir(), '.config', 'google-chrome'), 'Chrome'],
  [join(homedir(), '.config', 'chromium'), 'Chromium'],
  [join(homedir(), '.config', 'google-chrome-beta'), 'Chrome Beta'],
  [join(homedir(), '.config', 'microsoft-edge'), 'Edge'],
  [join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser'), 'Brave'],
];
for (const [dir, label] of browserHomes) {
  if (!existsSync(dir)) continue;
  const manifest = join(dir, 'NativeMessagingHosts', `${hostName}.json`);
  const manifestOk = existsSync(manifest);
  if (manifestOk) manifestFound = true;
  let profiles = [];
  try {
    profiles = readdirSync(dir).filter((entry) => entry === 'Default' || /^Profile \d+$/.test(entry));
  } catch {
    profiles = [];
  }
  const installed = profiles.filter((profile) => existsSync(join(dir, profile, 'Extensions', extensionId)));
  if (installed.length > 0) extensionFound = true;
  line(manifestOk ? OK : WARN, `${label} native host`, manifestOk ? manifest : 'manifest not installed');
  line(installed.length > 0 ? OK : WARN, `${label} extension`, installed.length > 0 ? `installed in ${installed.join(', ')}` : `extension ${extensionId} not found`);
  if (manifestOk) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      line(existsSync(parsed.path ?? '') ? OK : WARN, `${label} native host binary`, parsed.path ?? 'no path');
    } catch (error) {
      line(WARN, `${label} native host manifest`, `unreadable: ${String(error)}`);
    }
  }
}
if (!manifestFound) line(WARN, 'native messaging host', 'no browser profile has the Codex native host manifest');
if (!extensionFound) line(WARN, 'browser extension', 'the ChatGPT extension was not found in any browser profile');

process.stdout.write('\nRuntime probe\n-------------\n');
if (!deep) {
  line(WARN, 'browser connectivity', 'skipped (pass --deep to spawn the bridge and query chrome_status)');
} else if (runtime.nodeReplPath === null) {
  line(BAD, 'browser connectivity', 'cannot probe without node_repl');
} else {
  const bridge = new NodeReplBridge({
    command: runtime.nodeReplPath,
    args: [],
    env: nodeReplEnv(runtime),
    cwd: runtime.codexHome,
  });
  try {
    const helperPath = fileURLToPath(new URL('../lib/browser-session.mjs', import.meta.url));
    const result = await executeTool(bridge, { helperPath, browserClientPath: runtime.browserClientPath }, 'chrome_status', {});
    const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    const browsers = JSON.parse(text).browsers ?? [];
    line(browsers.length > 0 ? OK : WARN, 'browser connectivity', browsers.length > 0 ? `${browsers.length} connected: ${browsers.map((b) => `${b.name}(${b.type})`).join(', ')}` : 'no browser is connected to the extension');
  } catch (error) {
    line(BAD, 'browser connectivity', String(error?.message ?? error));
  } finally {
    await bridge.stop();
  }
}

process.stdout.write('\n');
if (runtime.problems.length > 0) {
  for (const problem of runtime.problems) line(BAD, 'problem', problem);
  process.exitCode = 1;
} else {
  line(OK, 'assets', 'all required Codex assets resolved');
}
