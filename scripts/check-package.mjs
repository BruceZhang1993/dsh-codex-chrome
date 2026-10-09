#!/usr/bin/env node
/**
 * `check-package.mjs` — static self-consistency checks that run without a
 * browser, without Codex, and without DSH. They catch the mistakes that
 * otherwise only show up as "the tools never appeared" or "the skill never
 * loaded":
 *
 *   - the bundle patch is declared and exists;
 *   - the launcher entry point exists and is exported;
 *   - every file listed in `files` exists (npm would silently drop the rest);
 *   - the patch mounts the MCP client bridge and resolves this package's
 *     launcher through its `exports` map;
 *   - the patch does not take over the shared `skill-filesystem` row;
 *   - the plugin entry registers the bundled skill, and that skill parses;
 *   - the skill directory name, frontmatter name, and patch `serverName` agree;
 *   - the bridge still injects the Codex turn metadata the vendor service
 *     requires — the single most load-bearing line in this package.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { TURN_METADATA_KEY } from '../lib/node-repl.mjs';
import { loadBundledSkill } from '../lib/skill.mjs';
import { TOOL_DEFINITIONS } from '../lib/tools.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const patchPath = pkg.dsh?.bundle?.patch;
check(typeof patchPath === 'string', 'package.json is missing dsh.bundle.patch');
check(typeof patchPath === 'string' && existsSync(join(root, patchPath)), `dsh.bundle.patch does not exist: ${patchPath}`);

for (const entry of pkg.files ?? []) {
  check(existsSync(join(root, entry)), `files entry does not exist: ${entry}`);
}

const exportsMap = pkg.exports ?? {};
check('./launcher' in exportsMap, 'exports must expose ./launcher (the patch resolves it)');
check('./session' in exportsMap, 'exports must expose ./session (the sandbox helper)');

const launcher = exportsMap['./launcher'];
check(typeof launcher === 'string' && existsSync(join(root, launcher)), `launcher entry point does not exist: ${launcher}`);
const session = exportsMap['./session'];
check(typeof session === 'string' && existsSync(join(root, session)), `session helper does not exist: ${session}`);
check(existsSync(join(root, 'lib/index.js')), 'lib/index.js (the plugin entry) does not exist');
check(pkg.main === 'lib/index.js', `package.json main must be lib/index.js, got ${pkg.main}`);

const patch = readFileSync(join(root, patchPath), 'utf8');
check(patch.includes("'@deepseek-ai/dsh-mcp-client'"), 'the patch must mount @deepseek-ai/dsh-mcp-client');
check(patch.includes("'dsh-codex-chrome/launcher'"), 'the patch must resolve the launcher');
check(/^\s*-\s*id:\s*dsh-codex-chrome\s*$/m.test(patch), 'the patch must mount this package as a plugin entry');
check(
  !/^\s*-\s*id:\s*skill-filesystem\s*$/m.test(patch),
  'the patch must not override skill-filesystem: bundledSkillDir is a single shared slot',
);

const entry = readFileSync(join(root, 'lib/index.js'), 'utf8');
check(entry.includes('loadBundledSkill'), 'the plugin entry must load the bundled skill');
check(/skills\.register\(/.test(entry), 'the plugin entry must register the skill on ctx.skills');

const serverName = /serverName:\s*["']?([A-Za-z0-9_-]+)["']?/.exec(patch)?.[1];
check(serverName !== undefined, 'the patch must declare a serverName');
check(
  serverName === undefined || /^[A-Za-z0-9_-]{1,32}$/.test(serverName),
  `serverName must match [A-Za-z0-9_-]{1,32}, got ${serverName}`,
);

const nodeRepl = readFileSync(join(root, 'lib/node-repl.mjs'), 'utf8');
check(TURN_METADATA_KEY === 'x-codex-turn-metadata', `turn metadata key changed: ${TURN_METADATA_KEY}`);
check(nodeRepl.includes('_meta'), 'the bridge must attach _meta to every tools/call');
check(nodeRepl.includes('turn_ended'), 'the bridge must be able to release a browser turn');

check(TOOL_DEFINITIONS.length === 11, `expected 11 tools, got ${TOOL_DEFINITIONS.length}`);
check(
  TOOL_DEFINITIONS.every((tool) => tool.name.startsWith('chrome_')),
  'every tool name must be prefixed with chrome_ so the DSH namespace stays predictable',
);
check(
  new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size === TOOL_DEFINITIONS.length,
  'tool names must be unique',
);

try {
  const skill = loadBundledSkill();
  check(skill.name === 'control-chrome', `skill name must be control-chrome, got ${skill.name}`);
  check(skill.description.length > 0, 'skill must carry a description');
  check(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0, 'skill should carry whenToUse');
  check(skill.content.trim().length > 0, 'skill body must not be empty');
  check(skill.content.startsWith('# Control Chrome'), 'skill body must start with its title');
  if (serverName !== undefined) {
    check(skill.content.includes(`mcp__${serverName}__`), `the skill must document tool names as mcp__${serverName}__<tool>`);
  }
} catch (error) {
  failures.push(`bundled skill does not load: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`check-package: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  `check-package: ok (serverName=${serverName}, launcher=${launcher}, tools=${TOOL_DEFINITIONS.length}, skill=control-chrome)\n`,
);
