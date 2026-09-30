# Agent action levels

A small vocabulary for what an agent's tool call is about to do, and a classifier that hooks can call.

The ladder says what an action is. It does not say what to do about it. Allow, ask or deny is a separate choice that belongs to whoever owns the project. The same ladder can sit behind a strict policy for a production repo and a loose one for a scratch folder.

## The ladder

| Rank | Level | Meaning | Examples |
|---|---|---|---|
| 0 | `read` | Looks at something and changes nothing. | Read, Glob, Grep. `ls`, `cat`, `git status`, `git log`. `curl` with GET. |
| 1 | `local-write` | Creates or changes files or state on this machine, in a way git or a backup can undo. | Write, Edit. `mkdir`, `cp`, `sed -i`. `git add`, `git commit`. `npm install`. |
| 2 | `delete` | Destroys data, or discards work that has no copy. | `rm`, `Remove-Item`. `git reset --hard`, `git clean`. `docker system prune`. SQL `DROP` or `DELETE`. |
| 3 | `external-send` | Sends data to another system or person, or changes state there. The sender cannot take it back. | `git push`. `curl -X POST`. `gh issue comment`. An MCP tool that creates or sends. |
| 4 | `deploy` | Publishes or releases something other people or systems will run or read. | `npm publish`, `docker push`. `netlify deploy`, `kubectl apply`, `terraform apply`. `git push` to `main`. |
| 5 | `spend` | Uses money or metered credit. | Calls to paid model APIs. Creating cloud machines. An MCP tool that generates media. |

The order is a judgement about blast radius and reversibility, and it is arguable. A send can be as hard to undo as a delete. That is why a classification carries every level a call touches, not only the top one, and why a policy names levels instead of comparing ranks.

The machine-readable copy of the ladder is `docs/levels.json`. A test keeps it equal to the ladder in the code.

## The classifier

```sh
guard-hooks classify "git push --force origin main"
```

```
deploy         git push --force origin main
               levels: delete, external-send, deploy
               flags: rewrites-remote-history
               git push sends commits to a remote
               push to a default or release branch usually triggers a deploy
               a forced push can overwrite remote history
```

The result has:

- `levels`: every level the call touches, lowest first.
- `level`: the highest of them.
- `flags`: extra facts a policy can act on.
- `reasons`: short sentences saying why, so a person can check the call.

In code:

```js
import { classifyTool, decide } from 'guard-hooks';

const c = classifyTool('Bash', { command: 'rm -rf build && git push origin main' });
// c.levels: ['delete', 'external-send', 'deploy']
decide(c, { ask: ['delete', 'deploy'], deny: ['spend'], askFlags: ['remote-code'] });
// { decision: 'ask', because: ['delete', 'deploy'] }
```

### Flags

| Flag | Meaning |
|---|---|
| `unclassified` | The classifier did not know the command or tool and made a cautious guess. A shell command it does not know counts as `local-write`. An MCP tool it cannot read counts as `external-send`. |
| `remote-code` | A download piped into a shell, or decoded and run, in the same command. |
| `rewrites-remote-history` | A forced push. |
| `installs-packages` | A package manager changes installed software. |
| `outside-project` | A Write or Edit target lies outside the working directory. |
| `delegates` | The call starts a sub-agent. Its own tool calls are classified when they run. |

### How each kind of call is read

- **Built-in tools.** By name. Read, Glob, Grep, WebSearch and WebFetch are `read`. Write, Edit and MultiEdit are `local-write`. A fetch counts as a read even though a URL can carry data out. The reason says so.
- **Shell commands (Bash and PowerShell).** Split at `;`, `&&`, `||`, `|` and newlines, leaving quoted text alone. Each part is read by its command name and arguments. `sudo`, `env`, `time` and assignments like `FOO=1` are skipped. `bash -c`, `powershell -Command` and `cmd /c` are opened up and classified inside. `$(...)` is classified too. Redirection to a file adds `local-write`.
- **MCP tools (`mcp__server__tool`).** By the leading verb in the tool name: `get`, `list`, `search` are `read`; `send`, `post`, `reply` are `external-send`; `delete`, `trash` are `delete`; `deploy`, `publish` are `deploy`; `generate`, `purchase`, `charge` are `spend`; `create`, `update`, `set` are `external-send`, because what an MCP server changes lives on another system. A name with no known verb is `external-send` and flagged `unclassified`.

### Project rules

A project can add to the classification in `.guard-hooks.json`:

```json
{
  "gate": {
    "ask": ["delete", "external-send", "deploy", "spend"],
    "deny": [],
    "askFlags": ["remote-code"],
    "rules": [
      { "tool": "^mcp__studio__render", "level": "spend" },
      { "command": "^\\./ship\\.sh", "level": "deploy" }
    ]
  }
}
```

A rule adds a level to whatever the built-in reading found. It never removes one.

## The gate hook

```sh
guard-hooks gate
```

reads the agent's JSON from stdin, classifies the call, and applies the policy. `read` and `local-write` produce no output, so Claude Code's own permission flow is untouched. A level listed under `ask` prints a `permissionDecision` of `ask` with the reasons. A level under `deny` exits with code 2 and the reason on stderr. The default policy asks for `delete`, `external-send`, `deploy` and `spend` and denies nothing.

## Limits

- It reads names and arguments. It does not run anything, resolve aliases or shell functions, read scripts, or expand variables. `./deploy.sh` is unclassified unless a rule names it.
- A determined command can hide its action: a string built at run time, a program that calls another program. The classifier is a safety net for ordinary calls, not a sandbox.
- The default lists of deploy commands and paid API hosts are short and were written by hand. Add to them with `rules`.
- The hook input names the tool and its input. It does not carry MCP tool annotations, so the classifier cannot use a server's own `readOnlyHint`.
- A level is a label for the action. It is not a statement that the action is wrong.
