/**
 * The bundled DSH skill.
 *
 * DSH can learn a skill from a filesystem root, but the provider that scans
 * those roots exposes exactly one `bundledSkillDir` slot (defaulting to
 * `$DSH_BUNDLED_SKILL_DIR`). Claiming that slot from a bundle patch would
 * *replace* whatever else owns it — for example the harness's own bundled
 * skills — so this package registers its skill on `ctx.skills` from its plugin
 * entry instead. Registration is additive, auditable, and independent of any
 * provider configuration.
 *
 * The document is a directory bundle (`<name>/SKILL.md`) with YAML frontmatter;
 * only the three scalar keys DSH consumes are read here, so this stays
 * dependency-free.
 *
 * @module dsh-codex-chrome/skill
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The skill's DSH name; must match `[a-z0-9]+(-[a-z0-9]+)*`. */
export const BUNDLED_SKILL_NAME = 'control-chrome';

/** Locator of the bundled skill document, relative to this module. */
export const bundledSkillUrl = new URL('../skills/control-chrome/SKILL.md', import.meta.url);

/** Keys DSH consumes from the frontmatter. */
const SCALAR_KEYS = ['name', 'description', 'whenToUse'];

/**
 * Read one `key: value` frontmatter line.
 * Values are plain scalars or single/double quoted strings; quoted values are
 * unescaped, so a `"` inside a double-quoted string is written `\"`.
 */
function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Split a skill document into its frontmatter scalars and its body.
 *
 * @throws {Error} when the document has no frontmatter block.
 */
export function parseSkillDocument(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (match === null) {
    throw new Error('skill document is missing its YAML frontmatter block');
  }
  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Nested or block-scalar lines are not part of the flat contract.
    if (/^[ \t]/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (SCALAR_KEYS.includes(key)) frontmatter[key] = parseScalar(value);
  }
  return { frontmatter, content: normalized.slice(match[0].length).replace(/^\n+/, '') };
}

/**
 * Load the bundled skill into the shape `ctx.skills.register` accepts.
 *
 * @param {URL} [url] - the skill document locator; defaults to the bundled one.
 * @throws {Error} when the document is missing or its frontmatter is incomplete.
 */
export function loadBundledSkill(url = bundledSkillUrl) {
  const path = fileURLToPath(url);
  const { frontmatter, content } = parseSkillDocument(readFileSync(path, 'utf8'));
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (name !== BUNDLED_SKILL_NAME) {
    throw new Error(`skill frontmatter name must be ${BUNDLED_SKILL_NAME}, got ${name ?? '<none>'}`);
  }
  if (description === undefined || description.length === 0) {
    throw new Error(`skill ${name} requires a non-empty description`);
  }
  const whenToUse = frontmatter.whenToUse;
  return {
    name,
    description,
    ...(whenToUse === undefined || whenToUse.length === 0 ? {} : { whenToUse }),
    content,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    source: 'runtime',
    provider: 'dsh-codex-chrome',
    invocation: { modelInvocable: true, userInvocable: true },
  };
}
