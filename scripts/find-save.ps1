# Helper: locate the STS2 save directory on Windows.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\find-save.ps1
$ErrorActionPreference = 'Stop'

$default = Join-Path $env:APPDATA 'SlayTheSpire2'

if (Test-Path $default) {
    Write-Host "Found: $default"
    Get-ChildItem -Force $default | Format-Table -AutoSize
    exit 0
}

Write-Host "Default path not found: $default"
Write-Host "Searching under %APPDATA% and %LOCALAPPDATA% for *spire*..."

$roots = @($env:APPDATA, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }

foreach ($root in $roots) {
    Write-Host ""
    Write-Host "--- $root ---"
    try {
        Get-ChildItem -Path $root -Directory -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)spire' } |
            Select-Object -ExpandProperty FullName
    } catch {
        # ignore access-denied dirs
    }
}

Write-Host ""
Write-Host "If Steam installed it elsewhere, open STS2, press the tilde (~) key,"
Write-Host "type 'open saves' in the debug console, and copy the path."
