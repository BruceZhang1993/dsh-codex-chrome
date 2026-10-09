/**
 * dsh-codex-chrome — DSH plugin entry.
 *
 * The bundle patch (`cordis.patch.yml`) mounts `bin/chrome-mcp.mjs` through
 * `@deepseek-ai/dsh-mcp-client`, which is what actually publishes the
 * `mcp__chrome__*` tools. This entry adds the two things a patch cannot
 * express:
 *
 *   - it registers the bundled `control-chrome` skill on `ctx.skills`, so the
 *     model can load the workflow on demand without taking over the shared
 *     `skill-filesystem.bundledSkillDir` slot; and
 *   - it reports, once at boot, whether the Codex assets the bridge depends on
 *     were found, because a missing `node_repl` or plugin cache otherwise only
 *     surfaces as a failed tool call.
 *
 * Every step is guarded: a missing service, an unresolvable asset or a
 * malformed skill must never take the plugin — or the profile — down.
 *
 * @module dsh-codex-chrome
 */

import { resolveRuntime } from './paths.mjs';
import { loadBundledSkill } from './skill.mjs';

/** Plugin name, as registered by the loader. */
export const name = 'dsh-codex-chrome';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? ctx.root?.logger;
  reportRuntime(logger);
  registerSkill(ctx, logger);
}

/** Log which Codex assets resolved — the first thing to check on failure. */
function reportRuntime(logger) {
  let runtime;
  try {
    runtime = resolveRuntime(process.env);
  } catch (error) {
    logger?.warn?.(`dsh-codex-chrome: runtime discovery failed: ${String(error)}`);
    return;
  }
  logger?.info?.(
    `dsh-codex-chrome: codex home ${runtime.codexHome}; browser client ${runtime.browserClientPath ?? '<missing>'}; ` +
      `node_repl ${runtime.nodeReplPath ?? '<missing>'}`,
  );
  for (const problem of runtime.problems) logger?.warn?.(`dsh-codex-chrome: ${problem}`);
}

/** Publish the bundled skill to the session catalog. */
function registerSkill(ctx, logger) {
  ctx.inject?.(['skills'], (skillCtx) => {
    const skills = skillCtx.skills;
    if (typeof skills?.register !== 'function') return;
    try {
      const skill = loadBundledSkill();
      skills.register(skill);
      logger?.info?.(`dsh-codex-chrome: skill "${skill.name}" registered from ${skill.path}`);
    } catch (error) {
      logger?.warn?.(`dsh-codex-chrome: bundled skill not registered: ${String(error)}`);
    }
  });
}
