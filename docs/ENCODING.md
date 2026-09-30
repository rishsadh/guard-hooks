# The encoding guard: what it checks and why

guard-hooks compares a file before and after a proposed write. It reports damage an agent causes without meaning to. Every check is a fact about bytes, not a guess about intent.

## Findings

| Code | Blocks | What it means |
|---|---|---|
| `bom-lost` | yes | The file started with a UTF-8 BOM (EF BB BF) and the result does not. |
| `bom-added` | yes | The file had no BOM and the result starts with one. |
| `encoding-changed` | yes | A UTF-16 or UTF-32 file would become something else. |
| `legacy-encoding-rewritten` | yes | The file is not valid UTF-8 (Latin-1, Windows-1252) and the write would convert it to UTF-8. |
| `invalid-utf8` | yes | The file was valid UTF-8 and the result is not. |
| `eol-changed` | yes | The file used one line ending throughout (CRLF, LF or CR) and the result uses another. |
| `eol-mixed` | yes | The file used one line ending throughout and the result has a mix. The message counts the odd lines. |
| `mojibake-introduced` | yes | The result has more mojibake sequences than the file had. The message shows up to three, with the repair. |
| `replacement-char-introduced` | yes | More U+FFFD characters than before. Text was lost on the way in. |
| `lossy-question-marks` | yes | Non-ASCII characters disappeared and question marks appeared. This is what a write through an ASCII or ANSI code page does. |
| `nul-introduced` | yes | NUL characters appeared. A UTF-16 file written as UTF-8 looks like this. |
| `bom-required` | yes | A new file matches `requireBom` in the config, has non-ASCII text and no BOM. |
| `bom-recommended` | warn | A new `.ps1`, `.psm1` or `.psd1` with non-ASCII text and no BOM. Windows PowerShell 5.1 reads it as ANSI. |
| `mixed-line-endings` | warn | `check` only. The file mixes line endings as it stands. |

A finding counts only when the change made things worse. A file that already contained mojibake, or already had mixed line endings, is not blamed for what it had before.

## How mojibake is recognised

Mojibake here means UTF-8 text that some program decoded as Latin-1 or Windows-1252. The detector looks for a character that maps back to a UTF-8 lead byte (0xC2 to 0xF4), followed by the right number of characters that map back to continuation bytes (0x80 to 0xBF). It then checks that those bytes decode as valid UTF-8. Only a sequence that can be undone exactly is reported, and the message shows the repair.

So "Ã©" is reported (it is the two bytes of "é" shown as Windows-1252), and a lone "Ã" or "Â" is not, because it has no continuation bytes behind it.

The Windows-1252 table is the Unicode Consortium mapping (unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP1252.TXT, cited in `src/text.js`). The five bytes that table leaves undefined are read as the matching Latin-1 control characters, as browsers do.

Limits: double-encoded text (mojibake of mojibake) is reported once, not fully unwound. The detector does not look at GBK, Shift-JIS or other multibyte code pages. Text that discusses mojibake, such as this page, contains examples that a stricter project may want to list under `ignore`.

## Line endings

CRLF is counted once, never as a CR plus an LF. A file with no line ending, or with mixed endings to begin with, raises no line-ending finding.

## What a hook can and cannot see

`pre-tool` runs before the agent's tool. What it can check depends on the tool:

- **Write.** The whole new content is known, so it is compared with the file on disk. Every finding above applies.
- **Edit and MultiEdit.** Only the replacement text is known. The editor reads and writes the file itself, so the hook cannot see what happens to the BOM or the line endings. It checks the new text for mojibake, replacement characters, NUL and lossy question marks, and it saves a fingerprint of the file.
- **Bash and PowerShell.** The command text is linted. The hook cannot see which files a command touches.

`post-tool` covers the gap. After a Write, Edit or MultiEdit it compares the file that is really on disk with the fingerprint from `pre-tool`. With `--fix` it restores a lost or added BOM and a flipped line-ending style, because those are exact. It never tries to repair mojibake. The fingerprint holds counts and flags only, never file content, and is kept in the system temp folder for at most a day.

`staged` covers everything else. It checks the staged blobs against `HEAD`, so it works for any agent and for people.

## What is measured, and what is cited

Measured on 2026-09-30 with `examples/ps51-roundtrip.ps1` in Windows PowerShell 5.1.26100.9444, ANSI code page Windows-1252. The test string is "caf", e-acute, a space, a Han character (U+4F60), CRLF, "x", CRLF.

| Case | Before | After |
|---|---|---|
| A. UTF-8 without BOM, `(Get-Content f) \| Set-Content f` | `63 61 66 C3 A9 20 E4 BD A0 0D 0A 78 0D 0A` | unchanged |
| B. UTF-8 with BOM, same command | `EF BB BF 63 61 66 C3 A9 20 E4 BD A0 0D 0A 78 0D 0A` | `63 61 66 E9 20 3F 0D 0A 78 0D 0A` |
| C. UTF-8 with BOM, `-Encoding UTF8` on both ends | `EF BB BF 63 61 66 C3 A9 20 E4 BD A0 0D 0A 78 0D 0A` | unchanged |

Case B is the damage: the BOM is gone, the e-acute became the single byte E9 (invalid UTF-8), and the Han character became `3F`, a question mark. Case A survives because reading and writing both use the ANSI code page, so the bytes round trip. The hook still blocks it, because the command cannot know in advance which case a file is.

Cited, read 2026-09-30:

- Windows PowerShell 5.1 `Set-Content`: the `-Encoding` default is `Default`, "the encoding that corresponds to the system's active code page (usually ANSI)". https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1
- Windows PowerShell 5.1 `Out-File`: the default is `unicode`, UTF-16 little-endian. https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/out-file?view=powershell-5.1
- `about_Character_Encoding`: in Windows PowerShell `>` and `>>` create UTF-16LE, and a script without a BOM is read as the ANSI code page. PowerShell 6 and later default to UTF-8 without a BOM. https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7.5
- Cursor forum, "Agent edits strip UTF-8 BOM encoding, corrupting builds", 2026-02-11. https://forum.cursor.com/t/agent-edits-strip-utf-8-bom-encoding-corrupting-builds/151517
- Claude Code issue 28316, "Write tool saves files as UTF-8 without BOM", opened 2026-02-24 and closed as a duplicate. The report shows Delphi and SQL Server Management Studio files turning into mojibake. https://github.com/anthropics/claude-code/issues/28316

One host note: the PowerShell used for the measurement sets `Out-File:Encoding` to `utf8` through `$PSDefaultParameterValues`, so `>` did not write UTF-16 there. The docs describe a stock install, and the hook warns on that basis.
