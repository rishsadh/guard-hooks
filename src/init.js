// Print the settings.json snippet that wires the hooks in. It never writes a settings file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'guard-hooks.js');

export function isEphemeralInstall(binPath = BIN) {
  return /[\\/]_npx[\\/]|[\\/]npx[\\/]/i.test(binPath);
}

/**
 * @param {{gate?: boolean, fix?: boolean, command?: string}} [opts]
 *   command: how the hook should call guard-hooks. Default: node with the absolute script path,
 *   which starts faster than npx on every tool call.
 */
export function settingsSnippet(opts = {}) {
  const fix = opts.fix !== false;
  const base = opts.command || (isEphemeralInstall() ? 'guard-hooks' : `node "${BIN.replace(/\\/g, '/')}"`);
  const pre = [
    { matcher: 'Write|Edit|MultiEdit|Bash|PowerShell', hooks: [{ type: 'command', command: `${base} pre-tool` }] },
  ];
  if (opts.gate) pre.push({ matcher: '*', hooks: [{ type: 'command', command: `${base} gate` }] });
  return {
    hooks: {
      PreToolUse: pre,
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `${base} post-tool${fix ? ' --fix' : ''}` }] },
      ],
    },
  };
}
