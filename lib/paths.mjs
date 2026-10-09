/**
 * dsh-codex-chrome — filesystem discovery for the Codex assets this bundle
 * reuses.
 *
 * Nothing here is hard-coded to one machine: every path is derived from
 * `CODEX_HOME`, a documented environment override, or a small candidate list,
 * and every candidate is verified with `existsSync` before it is returned.
 *
 * @module dsh-codex-chrome/paths
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the user's Codex installation. */
export function codexHome(env = process.env) {
  const configured = env.CODEX_HOME;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return join(homedir(), '.codex');
}

/** Compare two dotted numeric versions, highest last. */
function compareVersions(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

/** List `version` directories under `root`, newest last. */
function versionDirs(root) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => /^\d+(\.\d+)*$/.test(name))
      .filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/**
 * Resolve a bundled Codex plugin root.
 *
 * The `latest` symlink is preferred because that is what the Codex native
 * messaging host manifest points at, so the bridge and Chrome agree on the
 * extension-host binary. Version directories are the fallback when the symlink
 * is missing.
 *
 * @param {string} name - plugin directory name, e.g. `chrome`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ root: string|null, version: string|null, candidates: string[] }}
 */
export function resolvePlugin(name, env = process.env) {
  const home = codexHome(env);
  const caches = [
    join(home, 'plugins', 'cache', 'openai-bundled', name),
    join(home, 'plugins', 'linux-runtime-cache', 'openai-bundled', name),
  ];
  const candidates = [];
  for (const cache of caches) {
    const latest = join(cache, 'latest');
    candidates.push(latest);
    if (existsSync(latest)) return { root: latest, version: versionDirs(cache).at(-1) ?? null, candidates };
    const versions = versionDirs(cache);
    if (versions.length > 0) {
      const root = join(cache, versions.at(-1));
      candidates.push(root);
      return { root, version: versions.at(-1), candidates };
    }
  }
  const marketplace = join(home, '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', name);
  candidates.push(marketplace);
  if (existsSync(marketplace)) return { root: marketplace, version: null, candidates };
  return { root: null, version: null, candidates };
}

/** Candidate `node_repl` executables, most specific first. */
export function nodeReplCandidates(env = process.env) {
  const list = [];
  if (typeof env.DSH_CODEX_CHROME_NODE_REPL === 'string' && env.DSH_CODEX_CHROME_NODE_REPL.length > 0) {
    list.push(env.DSH_CODEX_CHROME_NODE_REPL);
  }
  list.push(
    '/usr/lib/chatgpt/resources/cua_node/bin/node_repl',
    '/opt/codex-desktop/resources/node_repl',
    '/opt/codex-desktop/resources/node_repl/bin/node_repl',
  );
  // Alternate ChatGPT/Codex desktop install roots.
  for (const base of ['/usr/lib', '/opt', join(homedir(), 'Applications')]) {
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base)) {
        list.push(join(base, entry, 'resources', 'cua_node', 'bin', 'node_repl'));
        list.push(join(base, entry, 'resources', 'node_repl'));
      }
    } catch {
      /* unreadable directory: skip */
    }
  }
  return [...new Set(list)];
}

/** First existing executable from {@link nodeReplCandidates}. */
export function resolveNodeRepl(env = process.env) {
  const candidates = nodeReplCandidates(env);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, candidates };
  }
  return { path: null, candidates };
}

/** Candidate Codex CLI binaries, used for the optional `CODEX_CLI_PATH`. */
export function resolveCodexCli(env = process.env) {
  const home = codexHome(env);
  const candidates = [
    '/usr/lib/chatgpt/resources/codex',
    '/opt/codex-desktop/resources/codex',
    join(home, 'plugins', '.plugin-appserver', 'codex'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Everything the bridge needs, resolved once per process.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   codexHome: string,
 *   chrome: { root: string|null, version: string|null, candidates: string[] },
 *   browser: { root: string|null, version: string|null, candidates: string[] },
 *   browserClientPath: string|null,
 *   browserServicePath: string|null,
 *   nodeReplPath: string|null,
 *   nodeReplCandidates: string[],
 *   codexCliPath: string|null,
 *   problems: string[],
 * }}
 */
export function resolveRuntime(env = process.env) {
  const home = codexHome(env);
  const chrome = resolvePlugin('chrome', env);
  const browser = resolvePlugin('browser', env);
  const browserClientPath = chrome.root === null ? null : join(chrome.root, 'scripts', 'browser-client.mjs');
  const browserServicePath = browser.root === null ? null : join(browser.root, 'scripts', 'browser-service.mjs');
  const nodeRepl = resolveNodeRepl(env);
  const codexCliPath = resolveCodexCli(env);

  const problems = [];
  if (chrome.root === null || !existsSync(browserClientPath ?? '')) {
    problems.push(
      `Codex chrome plugin not found (looked for scripts/browser-client.mjs under ${chrome.candidates.join(', ')}). ` +
        'Install or open the ChatGPT/Codex desktop app once so it materialises its bundled plugins.',
    );
  }
  if (browser.root === null || !existsSync(browserServicePath ?? '')) {
    problems.push(
      `Codex browser plugin not found (looked for scripts/browser-service.mjs under ${browser.candidates.join(', ')}).`,
    );
  }
  if (nodeRepl.path === null) {
    problems.push(
      `Codex node_repl runtime not found (tried ${nodeRepl.candidates.slice(0, 4).join(', ')}${nodeRepl.candidates.length > 4 ? ', …' : ''}). ` +
        'Set DSH_CODEX_CHROME_NODE_REPL to its absolute path.',
    );
  }

  return {
    codexHome: home,
    chrome,
    browser,
    browserClientPath,
    browserServicePath,
    nodeReplPath: nodeRepl.path,
    nodeReplCandidates: nodeRepl.candidates,
    codexCliPath,
    problems,
  };
}

/**
 * The environment `node_repl` expects, mirroring Codex's own
 * `[mcp_servers.node_repl.env]` block. `NODE_REPL_TRUSTED_SERVICES` is what lets
 * the browser client reach the vendor browser service, and
 * `NODE_REPL_TRUSTED_CODE_PATHS` is what lets the sandbox import this bundle's
 * session helper.
 *
 * @param {ReturnType<typeof resolveRuntime>} runtime
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {Record<string, string>}
 */
export function nodeReplEnv(runtime, base = process.env) {
  const binDir = runtime.nodeReplPath === null ? null : dirname(runtime.nodeReplPath);
  const cuaRoot = binDir === null ? null : dirname(binDir);
  const trustedCodePaths = [runtime.codexHome];
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  trustedCodePaths.push(packageRoot);

  /** @type {Record<string, string>} */
  const env = {
    ...base,
    CODEX_HOME: runtime.codexHome,
    NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths.join(':'),
    BROWSER_USE_AVAILABLE_BACKENDS: base.BROWSER_USE_AVAILABLE_BACKENDS ?? 'chrome,iab,mcpapps',
    BROWSER_USE_TINYSKY_ENABLED: base.BROWSER_USE_TINYSKY_ENABLED ?? '1',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: base.BROWSER_USE_CODEX_APP_BUILD_FLAVOR ?? 'prod',
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: base.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS ?? '1000',
  };
  if (cuaRoot !== null) {
    const moduleDirs = join(cuaRoot, 'lib', 'node_modules');
    if (base.NODE_REPL_NODE_MODULE_DIRS !== undefined) env.NODE_REPL_NODE_MODULE_DIRS = base.NODE_REPL_NODE_MODULE_DIRS;
    else if (existsSync(moduleDirs)) env.NODE_REPL_NODE_MODULE_DIRS = moduleDirs;
    const nodeBin = join(binDir, 'node');
    if (existsSync(nodeBin)) env.NODE_REPL_NODE_PATH = base.NODE_REPL_NODE_PATH ?? nodeBin;
  }
  if (runtime.chrome.version !== null) {
    env.BROWSER_USE_CODEX_APP_VERSION = base.BROWSER_USE_CODEX_APP_VERSION ?? runtime.chrome.version;
  }
  if (runtime.codexCliPath !== null) {
    env.CODEX_CLI_PATH = base.CODEX_CLI_PATH ?? runtime.codexCliPath;
  }
  if (runtime.browserServicePath !== null) {
    env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ browser: runtime.browserServicePath });
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
}
