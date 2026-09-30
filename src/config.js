// Optional per-project settings, read from .guard-hooks.json (nearest parent of the working directory).
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  ignore: [],
  allow: [],
  requireBom: [],
  powershell: '5.1',
  maxBytes: 5 * 1024 * 1024,
  gate: { ask: ['delete', 'external-send', 'deploy', 'spend'], deny: [], askFlags: ['remote-code'], rules: [] },
};

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

export function matchesGlob(glob, relPath) {
  return globToRegExp(glob).test(relPath.replace(/\\/g, '/'));
}

export function findConfigFile(startDir) {
  if (process.env.GUARD_HOOKS_CONFIG) return process.env.GUARD_HOOKS_CONFIG;
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const f = path.join(dir, '.guard-hooks.json');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.gate = { ...DEFAULTS.gate, ...(raw && raw.gate) };
  for (const k of ['ignore', 'allow', 'requireBom']) {
    if (!Array.isArray(cfg[k])) throw new Error(`.guard-hooks.json: "${k}" must be an array`);
  }
  for (const k of ['ask', 'deny', 'askFlags', 'rules']) {
    if (!Array.isArray(cfg.gate[k])) throw new Error(`.guard-hooks.json: "gate.${k}" must be an array`);
  }
  for (const a of cfg.allow) {
    if (!a || typeof a.glob !== 'string' || !Array.isArray(a.codes)) {
      throw new Error('.guard-hooks.json: each "allow" entry needs a "glob" string and a "codes" array');
    }
  }
  return cfg;
}

/** @returns {{config: object, root: string, file: string|null}} */
export function loadConfig(startDir) {
  const file = findConfigFile(startDir);
  if (!file) return { config: normalizeConfig({}), root: path.resolve(startDir || process.cwd()), file: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  return { config: normalizeConfig(raw), root: path.dirname(path.resolve(file)), file };
}
