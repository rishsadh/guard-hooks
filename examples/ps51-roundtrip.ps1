# Reproduces the PowerShell round trip that guard-hooks blocks, in Windows PowerShell 5.1.
# Run it with:  powershell.exe -NoProfile -File examples/ps51-roundtrip.ps1
# It works in a temporary folder and touches nothing else. The script is plain ASCII on purpose.

$dir = Join-Path ([System.IO.Path]::GetTempPath()) ('guard-hooks-' + [guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($dir)
function Hex($path) { (([System.IO.File]::ReadAllBytes($path) | ForEach-Object { '{0:X2}' -f $_ }) -join ' ') }

$eAcute = [char]0x00E9
$han    = [char]0x4F60
$text   = "caf$eAcute $han`r`nx`r`n"
$bom    = [byte[]](0xEF, 0xBB, 0xBF)

'PowerShell ' + $PSVersionTable.PSVersion + ', ANSI code page ' + [System.Text.Encoding]::Default.WebName
''

$a = Join-Path $dir 'no-bom.txt'
[System.IO.File]::WriteAllBytes($a, [System.Text.Encoding]::UTF8.GetBytes($text))
'A. UTF-8 without BOM, (Get-Content f) | Set-Content f'
'   before: ' + (Hex $a)
(Get-Content $a) | Set-Content $a
'   after : ' + (Hex $a)
''

$b = Join-Path $dir 'with-bom.txt'
[System.IO.File]::WriteAllBytes($b, $bom + [System.Text.Encoding]::UTF8.GetBytes($text))
'B. UTF-8 with BOM, same command'
'   before: ' + (Hex $b)
(Get-Content $b) | Set-Content $b
'   after : ' + (Hex $b)
''

$c = Join-Path $dir 'with-bom-utf8.txt'
[System.IO.File]::WriteAllBytes($c, $bom + [System.Text.Encoding]::UTF8.GetBytes($text))
'C. UTF-8 with BOM, -Encoding UTF8 on both ends'
'   before: ' + (Hex $c)
(Get-Content -Encoding UTF8 $c) | Set-Content -Encoding UTF8 $c
'   after : ' + (Hex $c)

[System.IO.Directory]::Delete($dir, $true)
