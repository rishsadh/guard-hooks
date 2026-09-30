// Check what is staged in git against HEAD. Works for any agent or person, because it looks
// at the commit, not at the tool that made the change.
import { execFileSync } from 'node:child_process';
import { analyzeChange } from './compare.js';
import { loadConfig } from './config.js';

const MAX = 64 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryShow(spec, cwd) {
  try {
    return git(['show', spec], cwd);
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd a path inside the repository
 * @returns {{path:string, findings:object[]}[]} one entry per staged file that has findings
 */
export function checkStaged(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd).toString('utf8').trim();
  const { config } = loadConfig(top);
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=AM', '-z'], top).toString('utf8');
  const files = out.split('\0').filter(Boolean);
  let hasHead = true;
  try { git(['rev-parse', '--verify', 'HEAD'], top); } catch { hasHead = false; }
  const results = [];
  for (const f of files) {
    const after = tryShow(`:${f}`, top);
    if (!after) continue;
    const before = hasHead ? tryShow(`HEAD:${f}`, top) : null;
    const findings = analyzeChange({ before, after, relPath: f, config });
    if (findings.length) results.push({ path: f, findings });
  }
  return results;
}
