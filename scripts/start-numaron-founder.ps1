param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
function Assert-NumaronOffForMaintenance {
    $powerFile = Join-Path $projectDirectory 'artifacts/founder-integration-20261012/power-state.jsonl'
    try {
        $powerState = Get-Content -LiteralPath $powerFile -Tail 1 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($powerState.enabled -isnot [bool]) { throw 'Ungültiger Status' }
    } catch {
        throw 'Wartungsneustart verweigert: Betriebszustand nicht sicher lesbar. Kein Prozess wurde beendet.'
    }
    if ($powerState.enabled) {
        throw 'Wartungsneustart verweigert: Numaron ist eingeschaltet. Laufenden Betrieb nicht für Wartung ausschalten; erst nach ausdrücklicher Stop-/Neustartfreigabe und bestätigtem OFF warten.'
    }
}
if ($Restart) { Assert-NumaronOffForMaintenance }
$running = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 51439 -State Listen -ErrorAction SilentlyContinue
if ($running -and $Restart) {
    $service = Get-CimInstance Win32_Process -Filter "ProcessId = $($running.OwningProcess)"
    if ($service.CommandLine -notmatch 'scripts/founder-mt5.mjs') { throw 'Port wird von einem anderen Dienst verwendet.' }
    $parentService = Get-CimInstance Win32_Process -Filter "ProcessId = $($service.ParentProcessId)"
    # Re-read immediately before the first destructive process action.
    Assert-NumaronOffForMaintenance
    if ($parentService.CommandLine -match 'scripts/founder-supervisor.mjs') { Stop-Process -Id $parentService.ProcessId }
    Stop-Process -Id $service.ProcessId
    $running = $null
}
if ($running) {
    Start-Process 'http://127.0.0.1:51439/'
    Write-Output 'numaron ist bereits gestartet. Bei abgelaufener Sitzung bitte den privaten Dienst neu starten.'
    exit 0
}
$nodeExecutable = (Get-Command node.exe).Source
Start-Process -FilePath $nodeExecutable -ArgumentList 'scripts/founder-supervisor.mjs' -WorkingDirectory $projectDirectory -WindowStyle Hidden
Write-Output 'numaron startet lokal und öffnet den persönlichen Anmeldelink im Browser.'
