$ErrorActionPreference = 'Stop'
$taskDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.numaron'
$taskFile = Join-Path $taskDirectory 'amplitude-secret.clixml'
if (Test-Path -LiteralPath $taskFile) { throw 'Amplitude credential already exists. Existing credential preserved.' }
$taskSecret = Read-Host 'Amplitude Secret Key des Projekts Numaron (878459), nicht den oeffentlichen API Key' -AsSecureString
if ($taskSecret.Length -lt 16 -or $taskSecret.Length -gt 256) { throw 'Unexpected Secret Key length.' }
New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
$taskSecret | Export-Clixml -LiteralPath $taskFile -Encoding UTF8
$taskSecret.Dispose()
Write-Output 'Amplitude credential encrypted for this Windows user. No key printed. The founder dashboard can now read aggregate statistics.'
