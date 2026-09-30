// Agent action levels: what kind of thing is this tool call about to do?
//
// The ladder is a vocabulary, not a policy. It says what an action is. What to do about each
// level (allow, ask, deny) is a separate choice, made in .guard-hooks.json or by the caller.
import { splitSegments, words } from './shell.js';

export const LEVELS = [
  {
    id: 'read', rank: 0,
    summary: 'Looks at something and changes nothing.',
    examples: ['Read, Glob, Grep', 'ls, cat, git status, git log', 'curl with GET'],
  },
  {
    id: 'local-write', rank: 1,
    summary: 'Creates or changes files or state on this machine, in a way git or a backup can undo.',
    examples: ['Write, Edit', 'mkdir, cp, mv, sed -i', 'git add, git commit', 'npm install'],
  },
  {
    id: 'delete', rank: 2,
    summary: 'Destroys data, or discards work that has no copy.',
    examples: ['rm, Remove-Item', 'git reset --hard, git clean', 'docker system prune', 'SQL DROP or DELETE'],
  },
  {
    id: 'external-send', rank: 3,
    summary: 'Sends data to another system or person, or changes state there. Cannot be taken back by the sender.',
    examples: ['git push', 'curl -X POST', 'gh issue comment', 'an MCP tool that creates or sends'],
  },
  {
    id: 'deploy', rank: 4,
    summary: 'Publishes or releases something that other people or systems will run or read.',
    examples: ['npm publish, docker push', 'netlify deploy, kubectl apply, terraform apply', 'git push to main'],
  },
  {
    id: 'spend', rank: 5,
    summary: 'Uses money or metered credit.',
    examples: ['calls to paid model APIs', 'creating cloud machines', 'an MCP tool that generates media'],
  },
];

const RANK = Object.fromEntries(LEVELS.map((l) => [l.id, l.rank]));
export const rankOf = (id) => RANK[id];

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'websearch', 'webfetch', 'todowrite', 'notebookread',
  'taskoutput', 'toolsearch', 'listmcpresources', 'readmcpresource', 'exitplanmode', 'askuserquestion', 'skill', 'sleep']);
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const DELEGATE_TOOLS = new Set(['task', 'agent']);

const MCP_VERBS = [
  ['spend', /^(generate|purchase|buy|pay|charge|checkout|order|subscribe|transfer|withdraw|topup|render|upscale|dub|synthesize)$/],
  ['deploy', /^(deploy|publish|release|launch|ship|promote)$/],
  ['delete', /^(delete|remove|trash|destroy|drop|purge|erase|wipe|cancel|revoke|clean)$/],
  ['external-send', /^(send|post|reply|forward|comment|message|invite|share|tweet|notify|respond|email|upload|connect)$/],
  ['local-write', /^(create|update|set|write|add|edit|upsert|patch|label|unlabel|move|rename|copy|insert|put|append|apply|mark|select|change|save|import|sync|stop|start|run|execute|open|close|batch|bind|unbind|pin|unpin|archive|unarchive)$/],
  ['read', /^(get|list|read|search|query|describe|find|show|fetch|view|retrieve|check|resolve|lookup|explore|export|download|status|balance|introspect|suggest|read_me|guide|docs|wait|display|reveal|transactions|jobs|context|models|apps)$/],
];

/** Classify an MCP tool by the verbs in its name. The server name is ignored. */
function classifyMcp(name) {
  const parts = name.split('__');
  const tool = parts.slice(2).join('__') || parts[parts.length - 1];
  const toks = tool.toLowerCase().split(/[_\-.]+/).filter(Boolean);
  // The leading verb decides: "get_message" reads, "send_message" sends.
  let levels = [];
  for (const t of toks) {
    const hit = MCP_VERBS.find(([, re]) => re.test(t));
    if (hit) { levels = [hit[0] === 'local-write' ? 'external-send' : hit[0]]; break; }
  }
  if (!levels.length) return { levels: ['external-send'], flags: ['unclassified'], reasons: [`MCP tool "${tool}" has no verb the classifier knows; assumed to act on another system`] };
  return { levels: [...new Set(levels)], flags: [], reasons: [`MCP tool name "${tool}" reads as ${levels.join(' and ')}`] };
}

const PAID_HOSTS = /(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.elevenlabs\.io|api\.replicate\.com|api\.stability\.ai|fal\.run|api\.mistral\.ai|api\.cohere\.com|api\.together\.xyz|api\.deepgram\.com|api\.runwayml\.com)/i;
const DEFAULT_BRANCH = /(^|[\s:/])(main|master|prod|production|release|trunk)($|\s)/i;

const SHELL_READ = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'tree', 'pwd',
  'cd', 'echo', 'printf', 'wc', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'stat', 'file', 'du', 'df', 'which', 'where', 'whoami', 'hostname',
  'date', 'env', 'printenv', 'ps', 'uname', 'id', 'true', 'false', 'test', '[', 'sleep', 'jq', 'basename', 'dirname', 'realpath', 'readlink',
  'nproc', 'tput', 'clear', 'pushd', 'popd', 'set-location', 'get-location', 'test-path', 'select-string', 'measure-object', 'sort-object',
  'where-object', 'select-object', 'format-table', 'format-list', 'out-string', 'write-output', 'write-host', 'resolve-path', 'split-path',
  'join-path', 'start-sleep', 'convertto-json', 'convertfrom-json', 'group-object', 'compare-object', 'xxd', 'hexdump', 'od', 'md5sum', 'sha256sum',
  'certutil', 'findstr', 'whereis', 'man', 'help', 'history', 'tasklist', 'ver', 'wait', 'seq', 'yes', 'expr', 'sed', 'awk', 'tr']);
const SHELL_WRITE = new Set(['mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'rename', 'ln', 'chmod', 'chown', 'tee',
  'install', 'dd', 'patch', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'ni', 'new-item', 'set-content', 'add-content', 'out-file', 'copy-item',
  'move-item', 'rename-item', 'clear-content', 'expand-archive', 'compress-archive', 'set-item', 'set-itemproperty', 'sc', 'ac', 'cpi', 'mi', 'mkdir.exe']);
const SHELL_DELETE = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'truncate', 'remove-item', 'ri', 'clear-recyclebin', 'rimraf']);

function gitSub(w) {
  for (let i = 1; i < w.length; i++) {
    if (w[i] === '-C' || w[i] === '-c' || w[i] === '--git-dir' || w[i] === '--work-tree') { i++; continue; }
    if (w[i].startsWith('-')) continue;
    return { sub: w[i], args: w.slice(i + 1) };
  }
  return { sub: '', args: [] };
}

function hasFlag(args, ...names) {
  return args.some((a) => names.includes(a) || names.some((n) => n.length > 2 && a.startsWith(n + '=')));
}

function classifyGit(w) {
  const { sub, args } = gitSub(w);
  const text = args.join(' ');
  switch (sub) {
    case 'status': case 'log': case 'diff': case 'show': case 'blame': case 'grep': case 'ls-files': case 'ls-tree': case 'rev-parse':
    case 'describe': case 'shortlog': case 'reflog': case 'fetch': case 'remote': case 'config': case 'cat-file': case 'rev-list':
    case 'merge-base': case 'name-rev': case 'check-ignore': case 'count-objects': case 'whatchanged': case 'for-each-ref': case 'ls-remote':
      if (sub === 'remote' && /\b(add|remove|rm|rename|set-url|prune)\b/.test(text)) return { levels: ['local-write'], reasons: ['git remote change'] };
      if (sub === 'config' && !/--get|--list|-l\b/.test(text)) return { levels: ['local-write'], reasons: ['git config change'] };
      return { levels: ['read'], reasons: [`git ${sub}`] };
    case 'branch':
      if (hasFlag(args, '-D') || (hasFlag(args, '-d') && hasFlag(args, '-f'))) return { levels: ['delete'], reasons: ['git branch -D discards unmerged commits'] };
      if (hasFlag(args, '-d', '--delete')) return { levels: ['delete'], reasons: ['git branch -d deletes a branch'] };
      return { levels: args.some((a) => !a.startsWith('-')) ? ['local-write'] : ['read'], reasons: ['git branch'] };
    case 'tag':
      return { levels: hasFlag(args, '-d') ? ['delete'] : args.length ? ['local-write'] : ['read'], reasons: ['git tag'] };
    case 'stash':
      return /\b(drop|clear)\b/.test(text) ? { levels: ['delete'], reasons: ['git stash drop or clear'] } : /\b(list|show)\b/.test(text) ? { levels: ['read'], reasons: ['git stash list'] } : { levels: ['local-write'], reasons: ['git stash'] };
    case 'reset':
      return hasFlag(args, '--hard') ? { levels: ['delete'], reasons: ['git reset --hard discards uncommitted work'] } : { levels: ['local-write'], reasons: ['git reset'] };
    case 'clean':
      return { levels: ['delete'], reasons: ['git clean removes untracked files'] };
    case 'checkout': case 'restore': case 'switch':
      if ((sub === 'checkout' && /(^|\s)--(\s|$)/.test(text)) || (sub === 'restore' && !hasFlag(args, '--staged')) || (sub === 'checkout' && /(^|\s)\.(\s|$)/.test(text))) {
        return { levels: ['delete'], reasons: [`git ${sub} overwrites working files`] };
      }
      return { levels: ['local-write'], reasons: [`git ${sub}`] };
    case 'push': {
      const force = hasFlag(args, '-f', '--force', '--force-with-lease', '--force-if-includes') || /\s\+\S/.test(' ' + text);
      const del = hasFlag(args, '--delete', '-d') || /\s:\S/.test(' ' + text);
      const levels = ['external-send'];
      const flags = [];
      const reasons = ['git push sends commits to a remote'];
      if (DEFAULT_BRANCH.test(text) || hasFlag(args, '--tags', '--mirror', '--all')) { levels.push('deploy'); reasons.push('push to a default or release branch usually triggers a deploy'); }
      if (force) { levels.push('delete'); flags.push('rewrites-remote-history'); reasons.push('a forced push can overwrite remote history'); }
      if (del) { levels.push('delete'); reasons.push('deletes a remote ref'); }
      return { levels, flags, reasons };
    }
    default:
      return { levels: ['local-write'], reasons: [`git ${sub || '(no subcommand)'}`] };
  }
}

function classifyGh(w) {
  const area = w[1] || '';
  const verb = w[2] || '';
  const text = w.join(' ');
  if (area === 'api') {
    const method = /(?:-X|--method)\s+([A-Za-z]+)/.exec(text);
    if (method && method[1].toUpperCase() !== 'GET') return { levels: [method[1].toUpperCase() === 'DELETE' ? 'delete' : 'external-send', 'external-send'], reasons: ['gh api with a write method'] };
    if (/(^|\s)(-f|-F|--field|--raw-field|--input)\b/.test(text)) return { levels: ['external-send'], reasons: ['gh api with fields sends a POST'] };
    return { levels: ['read'], reasons: ['gh api GET'] };
  }
  if (/^(view|list|status|diff|checks|search|browse|clone|download)$/.test(verb) || area === 'search' || area === 'status') return { levels: ['read'], reasons: [`gh ${area} ${verb}`] };
  if (area === 'release' && /^(create|upload|edit)$/.test(verb)) return { levels: ['deploy', 'external-send'], reasons: ['gh release publishes'] };
  if (/^(delete|remove)$/.test(verb)) return { levels: ['delete', 'external-send'], reasons: [`gh ${area} ${verb}`] };
  if (area === 'auth' || area === 'config') return { levels: ['local-write'], reasons: [`gh ${area}`] };
  if (area === 'workflow' && verb === 'run') return { levels: ['deploy', 'external-send'], reasons: ['gh workflow run starts a CI run'] };
  if (area === 'pr' && verb === 'merge') return { levels: ['deploy', 'external-send'], reasons: ['gh pr merge changes the default branch'] };
  return { levels: ['external-send'], reasons: [`gh ${area} ${verb} changes GitHub`] };
}

function classifyCurl(w, text) {
  const writeFlag = /(^|\s)(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-d\b|--data\S*|-F\b|--form\S*|-T\b|--upload-file|--json)/i.test(text);
  const levels = [];
  const reasons = [];
  if (PAID_HOSTS.test(text)) { levels.push('spend'); reasons.push('call to a paid API host'); }
  if (writeFlag) { levels.push('external-send'); reasons.push('HTTP request with a body or a write method'); }
  if (!levels.length) { levels.push('read'); reasons.push('HTTP GET'); }
  if (/(^|\s)(-o|-O|--output|--remote-name)\b/.test(text)) levels.push('local-write');
  return { levels, reasons };
}

function classifyPsWeb(text) {
  const levels = [];
  const reasons = [];
  if (PAID_HOSTS.test(text)) { levels.push('spend'); reasons.push('call to a paid API host'); }
  if (/-Method\s+['"]?(Post|Put|Patch|Delete)\b|-Body\b|-InFile\b/i.test(text)) { levels.push('external-send'); reasons.push('web request with a body or a write method'); }
  if (!levels.length) { levels.push('read'); reasons.push('web GET'); }
  if (/-OutFile\b/i.test(text)) levels.push('local-write');
  return { levels, reasons };
}

const DEPLOY_CMDS = [
  [/^(npm|pnpm|yarn|bun)$/, (a) => /^publish$/.test(a[0])],
  [/^cargo$/, (a) => a[0] === 'publish'],
  [/^(twine|flit)$/, (a) => /^(upload|publish)$/.test(a[0])],
  [/^docker$/, (a) => a[0] === 'push' || (a[0] === 'buildx' && a.includes('--push'))],
  [/^(netlify|vercel|wrangler|firebase|fly|flyctl|railway|surge|serverless|sls|amplify)$/, (a) => /^(deploy|publish|--prod|up|release)/.test(a[0] || '') || a.includes('--prod')],
  [/^kubectl$/, (a) => /^(apply|create|rollout|scale|patch|replace|set|expose|run)$/.test(a[0])],
  [/^helm$/, (a) => /^(install|upgrade|rollback|uninstall)$/.test(a[0])],
  [/^(terraform|tofu)$/, (a) => a[0] === 'apply'],
  [/^pulumi$/, (a) => a[0] === 'up'],
  [/^(sam|cdk)$/, (a) => a[0] === 'deploy'],
  [/^(aws|gcloud|az)$/, (a) => a.some((x) => /^(deploy|publish|release)$/.test(x))],
  [/^heroku$/, (a) => /^(releases|deploy|container:release)/.test(a[0] || '')],
];

const SPEND_CMDS = [
  [/^stripe$/, (a) => /^(charges|payment_intents|refunds|payouts|transfers|invoices|subscriptions|checkout)/.test(a[0] || '') && a.includes('create')],
  [/^aws$/, (a) => (a[0] === 'ec2' && a[1] === 'run-instances') || (a[0] === 'rds' && /^create-db/.test(a[1] || '')) || (a[0] === 'bedrock-runtime')],
  [/^gcloud$/, (a) => a[0] === 'compute' && a[1] === 'instances' && a[2] === 'create'],
  [/^az$/, (a) => a[0] === 'vm' && a[1] === 'create'],
  [/^doctl$/, (a) => a[0] === 'compute' && a[1] === 'droplet' && a[2] === 'create'],
  [/^(openai|replicate)$/, () => true],
];

function baseName(w0) {
  return (w0 || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Strip wrappers that do not change what a command does. */
function unwrap(w) {
  let i = 0;
  while (i < w.length) {
    const t = w[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'call'].includes(baseName(t))) { i++; continue; }
    break;
  }
  return w.slice(i);
}

const INFRA_CLIS = new Set(['kubectl', 'docker', 'terraform', 'tofu', 'helm', 'aws', 'gcloud', 'az', 'netlify', 'vercel', 'wrangler', 'firebase', 'fly', 'flyctl', 'heroku', 'pulumi', 'stripe']);

function infraReadOnly(cmd, args) {
  const first = args.find((a) => !a.startsWith('-')) || '';
  if (/^(get|describe|logs|list|ls|ps|images|inspect|plan|validate|show|status|version|whoami|diff|top|events|info|help|search|history|stats|fmt|preview)$/.test(first)) return true;
  if (cmd === 'aws' || cmd === 'gcloud' || cmd === 'az') return args.some((a) => /^(describe|list|get|show)(-|$)/.test(a)) && !args.some((a) => /^(delete|terminate|create|run|put|update|deploy)/.test(a));
  return args.length > 0 && args.every((a) => /^(--version|-v|version|--help|-h)$/.test(a));
}

function classifySegment(text, tool, depth) {
  const flags = [];
  const reasons = [];
  let levels = [];
  const levelsOf = (r) => { levels.push(...r.levels); reasons.push(...(r.reasons || [])); flags.push(...(r.flags || [])); };

  // Nested command substitutions and inline interpreters.
  const subs = [...text.matchAll(/\$\(([^()]*)\)/g)].map((m) => m[1]);
  if (depth < 3) for (const s of subs) { const r = classifyCommand(s, { tool, depth: depth + 1 }); levels.push(...r.levels); reasons.push(...r.reasons); flags.push(...r.flags); }

  let w = unwrap(words(text.replace(/\$\([^()]*\)/g, ' ')));
  if (!w.length) return { levels: levels.length ? levels : ['read'], reasons, flags };
  const cmd = baseName(w[0]);
  const args = w.slice(1);

  if (['bash', 'sh', 'zsh', 'dash'].includes(cmd) && (args[0] === '-c' || args[0] === '-lc') && args[1] && depth < 3) {
    const r = classifyCommand(args[1], { tool: 'Bash', depth: depth + 1 });
    return { levels: [...levels, ...r.levels], reasons: [...reasons, ...r.reasons], flags: [...flags, ...r.flags] };
  }
  if (['powershell', 'pwsh'].includes(cmd) && depth < 3) {
    const ci = args.findIndex((a) => /^-(c|command)$/i.test(a));
    const inner = ci >= 0 ? args.slice(ci + 1).join(' ') : '';
    if (inner) {
      const r = classifyCommand(inner, { tool: 'PowerShell', depth: depth + 1 });
      return { levels: [...levels, ...r.levels], reasons: [...reasons, ...r.reasons], flags: [...flags, ...r.flags] };
    }
  }
  if (cmd === 'cmd' && /^\/c$/i.test(args[0] || '') && depth < 3) {
    const r = classifyCommand(args.slice(1).join(' '), { tool: 'Bash', depth: depth + 1 });
    return { levels: [...levels, ...r.levels], reasons: [...reasons, ...r.reasons], flags: [...flags, ...r.flags] };
  }

  // output redirection writes a file (not 2>&1, >&2, /dev/null, $null, nul)
  const redirect = /(?:^|[^>\d&<-])(\d?>{1,2})\s*(?!&|\/dev\/null|\$null|nul\b)([^\s|&;<>]+)/i.exec(text.replace(/"[^"]*"|'[^']*'/g, '""'));
  const redirectsToFile = !!redirect;

  const tableHits = [];
  for (const [re, test] of DEPLOY_CMDS) if (re.test(cmd) && test(args)) tableHits.push({ level: 'deploy', reason: `${cmd} ${args[0] || ''} publishes or releases`.replace(/\s+/g, ' ') });
  for (const [re, test] of SPEND_CMDS) if (re.test(cmd) && test(args)) tableHits.push({ level: 'spend', reason: `${cmd} uses paid or metered services` });

  if (cmd === 'git') levelsOf(classifyGit(['git', ...args]));
  else if (cmd === 'gh') levelsOf(classifyGh(['gh', ...args]));
  else if (['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(cmd) || (tool === 'PowerShell' && (cmd === 'curl' || cmd === 'wget'))) levelsOf(classifyPsWeb(text));
  else if (cmd === 'curl' || cmd === 'http' || cmd === 'https') levelsOf(classifyCurl(w, text));
  else if (cmd === 'wget') {
    const posts = /--post-data|--post-file|--method[= ]\s*(post|put|patch|delete)/i.test(text);
    levelsOf(posts ? { levels: ['external-send', 'local-write'], reasons: ['wget with a request body'] } : { levels: ['local-write'], reasons: ['wget saves a file'] });
  }
  else if (['send-mailmessage', 'mail', 'mailx', 'sendmail', 'mutt', 'msmtp', 'nc', 'ncat', 'telnet', 'ftp', 'sftp'].includes(cmd)) levelsOf({ levels: ['external-send'], reasons: [`${cmd} sends data off this machine`] });
  else if (cmd === 'scp' || cmd === 'rsync') {
    const remote = args.some((a) => /^[\w.@-]{2,}:/.test(a)); // host:path; a drive letter is one character
    levelsOf(remote ? { levels: ['external-send'], reasons: [`${cmd} to or from a remote host`] } : { levels: ['local-write'], reasons: [`${cmd} between local paths`] });
  } else if (cmd === 'ssh') levelsOf({ levels: ['external-send'], flags: ['unclassified'], reasons: ['ssh runs commands on another machine'] });
  else if (tableHits.length) levelsOf({ levels: tableHits.map((h) => h.level), reasons: tableHits.map((h) => h.reason) });
  else if (INFRA_CLIS.has(cmd) && infraReadOnly(cmd, args)) levelsOf({ levels: ['read'], reasons: [`${cmd} ${args[0] || ''} only reads`.replace(/\s+/g, ' ')] });
  else if (SHELL_DELETE.has(cmd)) levelsOf({ levels: ['delete'], reasons: [`${cmd} removes files`] });
  else if (cmd.startsWith('remove-')) levelsOf({ levels: ['delete'], reasons: [`${cmd} removes things`] });
  else if (cmd === 'find' && /(^|\s)-delete\b|-exec\s+(rm|del)\b/.test(text)) levelsOf({ levels: ['delete'], reasons: ['find deletes what it matches'] });
  else if (cmd === 'find') levelsOf({ levels: ['read'], reasons: ['find'] });
  else if (cmd === 'sed' && /(^|\s)-i/.test(text)) levelsOf({ levels: ['local-write'], reasons: ['sed -i edits files in place'] });
  else if ((cmd === 'perl' || cmd === 'ruby') && /(^|\s)-\w*i/.test(text)) levelsOf({ levels: ['local-write'], reasons: [`${cmd} -i edits files in place`] });
  else if (['psql', 'mysql', 'sqlite3', 'mongosh', 'sqlcmd'].includes(cmd)) {
    if (/\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i.test(text)) levelsOf({ levels: ['delete'], reasons: ['SQL that destroys rows or tables'] });
    else if (/\b(insert|update|create|alter)\b/i.test(text)) levelsOf({ levels: ['local-write'], reasons: ['SQL that changes data'] });
    else levelsOf({ levels: ['read'], flags: ['unclassified'], reasons: ['database client with no recognised write'] });
  } else if (cmd === 'docker' && /^(rm|rmi|system|volume|network|image|container)$/.test(args[0] || '') && /\b(rm|prune|remove)\b/.test(text)) levelsOf({ levels: ['delete'], reasons: ['docker removes containers, images or volumes'] });
  else if (cmd === 'kubectl' && args[0] === 'delete') levelsOf({ levels: ['delete', 'deploy'], reasons: ['kubectl delete'] });
  else if ((cmd === 'terraform' || cmd === 'tofu') && args[0] === 'destroy') levelsOf({ levels: ['delete', 'deploy'], reasons: ['terraform destroy'] });
  else if (cmd === 'aws' && /\b(s3 rm|s3 rb|delete-|terminate-)/.test(text)) levelsOf({ levels: ['delete', 'external-send'], reasons: ['aws delete or terminate call'] });
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && /^(install|i|ci|add|update|upgrade|remove|uninstall|link|dedupe|prune|rebuild)$/.test(args[0] || '')) {
    levelsOf({ levels: [/^(remove|uninstall)$/.test(args[0]) ? 'delete' : 'local-write'], flags: ['installs-packages'], reasons: ['package manager changes node_modules'] });
  } else if (['pip', 'pip3', 'pipx', 'uv', 'poetry', 'cargo', 'go', 'gem', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'winget', 'choco', 'scoop', 'install-module', 'install-package'].includes(cmd) && /install|add|update|upgrade/.test(args.join(' ') || cmd)) {
    levelsOf({ levels: ['local-write'], flags: ['installs-packages'], reasons: [`${cmd} installs software`] });
  } else if (SHELL_WRITE.has(cmd)) levelsOf({ levels: ['local-write'], reasons: [`${cmd} writes files`] });
  else if (SHELL_READ.has(cmd) || cmd.startsWith('get-') || cmd.startsWith('format-') || /^(test-|measure-|select-|convertto-|convertfrom-)/.test(cmd)) levelsOf({ levels: ['read'], reasons: [`${cmd} only reads`] });
  else if (['node', 'python', 'python3', 'py', 'deno', 'ruby', 'php'].includes(cmd) && args.every((a) => /^(-v|--version|-V)$/.test(a)) && args.length) levelsOf({ levels: ['read'], reasons: [`${cmd} version`] });
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && /^(ls|list|view|info|outdated|audit|help|config|explain|why|root|bin|prefix|whoami|pack|--version|-v)$/.test(args[0] || '') && !/\bfix\b/.test(text)) levelsOf({ levels: ['read'], reasons: ['package manager query'] });
  else levelsOf({ levels: ['local-write'], flags: ['unclassified'], reasons: [`${cmd} is not a command the classifier knows, so it may write files`] });

  if (redirectsToFile) { levels.push('local-write'); reasons.push(`output redirected to ${redirect[2]}`); }
  return { levels, reasons, flags };
}

/**
 * Classify a shell or PowerShell command.
 * @param {string} command
 * @param {{tool?: string, depth?: number}} [opts]
 * @returns {{levels: string[], level: string, rank: number, reasons: string[], flags: string[]}}
 */
export function classifyCommand(command, opts = {}) {
  const tool = opts.tool || 'Bash';
  const depth = opts.depth || 0;
  const levels = new Set();
  const reasons = [];
  const flags = new Set();
  const segs = splitSegments(command);
  if (!segs.length) levels.add('read');
  // A download piped into a shell, or decoded and run, is code nobody reviewed.
  if (/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(iex|invoke-expression)\b|base64\s+(-d|--decode)[^|]*\|\s*(ba)?sh\b/i.test(command)) {
    flags.add('remote-code');
    reasons.push('runs code that was fetched or decoded in the same command');
  }
  for (const s of segs) {
    const r = classifySegment(s.text, tool, depth);
    r.levels.forEach((l) => levels.add(l));
    reasons.push(...r.reasons);
    r.flags.forEach((f) => flags.add(f));
  }
  // `read` only stands if nothing else was found.
  if (levels.size > 1) levels.delete('read');
  return finish([...levels], reasons, [...flags]);
}

function finish(levels, reasons, flags) {
  const uniq = [...new Set(levels)];
  uniq.sort((a, b) => RANK[a] - RANK[b]);
  const top = uniq[uniq.length - 1] || 'read';
  return { levels: uniq, level: top, rank: RANK[top], reasons: [...new Set(reasons)], flags: [...new Set(flags)] };
}

/**
 * Classify one agent tool call.
 * @param {string} toolName e.g. "Write", "Bash", "mcp__gmail__send_message"
 * @param {object} [input] the tool input
 * @param {{rules?: {tool?: string, command?: string, level: string, flag?: string}[], cwd?: string}} [opts]
 */
export function classifyTool(toolName, input = {}, opts = {}) {
  const name = String(toolName || '');
  const lname = name.toLowerCase();
  const levels = [];
  const reasons = [];
  const flags = [];

  for (const rule of opts.rules || []) {
    if (!RANK.hasOwnProperty(rule.level)) continue;
    const toolHit = rule.tool && new RegExp(rule.tool, 'i').test(name);
    const cmdHit = rule.command && typeof input.command === 'string' && new RegExp(rule.command, 'i').test(input.command);
    if (toolHit || cmdHit) { levels.push(rule.level); reasons.push(`project rule: ${rule.tool || rule.command}`); if (rule.flag) flags.push(rule.flag); }
  }

  if (lname === 'bash' || lname === 'powershell') {
    const r = classifyCommand(String(input.command || ''), { tool: lname === 'bash' ? 'Bash' : 'PowerShell' });
    levels.push(...r.levels); reasons.push(...r.reasons); flags.push(...r.flags);
  } else if (READ_TOOLS.has(lname)) {
    levels.push('read'); reasons.push(`${name} only reads`);
    if (lname === 'webfetch') reasons.push('the URL itself can carry data out; this ladder treats a fetch as a read');
  } else if (WRITE_TOOLS.has(lname)) {
    levels.push('local-write'); reasons.push(`${name} changes a file`);
    const target = input.file_path || input.notebook_path;
    if (target && opts.cwd && isOutside(target, opts.cwd)) flags.push('outside-project');
  } else if (DELEGATE_TOOLS.has(lname)) {
    levels.push('read'); reasons.push('starts a sub-agent; its own tool calls are classified when they run'); flags.push('delegates');
  } else if (lname.startsWith('mcp__')) {
    const r = classifyMcp(name);
    levels.push(...r.levels); reasons.push(...r.reasons); flags.push(...r.flags);
  } else if (!levels.length) {
    levels.push('external-send'); reasons.push(`${name} is not a tool the classifier knows; assumed to act on another system`); flags.push('unclassified');
  }
  return finish(levels.length > 1 ? levels.filter((l) => l !== 'read') : levels, reasons, flags);
}

function isOutside(target, cwd) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const t = norm(target);
  const c = norm(cwd);
  if (!/^([a-z]:)?\//.test(t)) return false; // relative paths stay inside
  return !(t === c || t.startsWith(c + '/'));
}

/** What to do about a classification, given a policy. */
export function decide(classification, gate = {}) {
  const deny = new Set(gate.deny || []);
  const ask = new Set(gate.ask || []);
  const askFlags = new Set(gate.askFlags || []);
  const hitDeny = classification.levels.filter((l) => deny.has(l));
  if (hitDeny.length) return { decision: 'deny', because: hitDeny };
  const hitAsk = classification.levels.filter((l) => ask.has(l));
  const hitFlags = classification.flags.filter((f) => askFlags.has(f));
  if (hitAsk.length || hitFlags.length) return { decision: 'ask', because: [...hitAsk, ...hitFlags] };
  return { decision: 'allow', because: [] };
}
