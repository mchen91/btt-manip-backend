[CmdletBinding()]
param(
    [string]$Hotkey = "ALT+SHIFT+F11",
    [string]$OutputDirectory = (Join-Path $env:USERPROFILE "Desktop\Dolphin-Traces"),
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$presentMonVersion = "2.5.1"
$presentMonSha256 = "9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191"
$presentMonPath = Join-Path $env:LOCALAPPDATA "Temp\PresentMon-$presentMonVersion-x64.exe"
$presentMonUrl = "https://github.com/GameTechDev/PresentMon/releases/download/v$presentMonVersion/PresentMon-$presentMonVersion-x64.exe"
$sessionName = "DolphinStutterCapture"

function Install-PresentMonIfNeeded {
    $valid = Test-Path -LiteralPath $presentMonPath
    if ($valid) {
        $actualHash = (Get-FileHash -LiteralPath $presentMonPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $valid = $actualHash -eq $presentMonSha256
    }

    if ($valid) {
        return
    }

    Write-Host "Downloading portable PresentMon $presentMonVersion..."
    Invoke-WebRequest -UseBasicParsing -Uri $presentMonUrl -OutFile $presentMonPath
    $actualHash = (Get-FileHash -LiteralPath $presentMonPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $presentMonSha256) {
        Remove-Item -LiteralPath $presentMonPath -Force
        throw "PresentMon checksum verification failed."
    }
}

Install-PresentMonIfNeeded

$dolphins = @(Get-Process -Name "Dolphin" -ErrorAction SilentlyContinue)
if ($dolphins.Count -eq 0) {
    throw "Dolphin is not running. Start Dolphin and the game, then run this script again."
}

if ($dolphins.Count -gt 1) {
    $dolphin = $dolphins | Sort-Object StartTime -Descending | Select-Object -First 1
    Write-Warning "More than one Dolphin process is running; tracing the newest one (PID $($dolphin.Id))."
} else {
    $dolphin = $dolphins[0]
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputBase = Join-Path $OutputDirectory "dolphin-stutter-$timestamp.csv"
$arguments = @(
    "--process_id", [string]$dolphin.Id,
    "--hotkey", $Hotkey,
    "--output_file", $outputBase,
    "--v2_metrics",
    "--scroll_indicator",
    "--no_console_stats",
    "--session_name", $sessionName,
    "--stop_existing_session"
)

Write-Host "Dolphin PID: $($dolphin.Id)"
Write-Host "Capture hotkey: $Hotkey"
Write-Host "Trace directory: $OutputDirectory"

if ($ValidateOnly) {
    Write-Host "Validation passed; no capture was started."
    exit 0
}

Write-Host ""
Write-Host "1. Return to Dolphin."
Write-Host "2. Press $Hotkey to START tracing just before normal play."
Write-Host "3. When you notice choppiness, press $Hotkey again to STOP tracing."
Write-Host "4. Return here and press Enter to finish."
Write-Host ""

$presentMon = Start-Process -FilePath $presentMonPath -ArgumentList $arguments -PassThru -NoNewWindow
Start-Sleep -Milliseconds 750

try {
    Read-Host "Press Enter after you have stopped the trace"
} finally {
    & $presentMonPath --session_name $sessionName --terminate_existing_session --no_csv 2>$null | Out-Null
    if (-not $presentMon.HasExited) {
        $presentMon.WaitForExit(3000) | Out-Null
    }
}

$stem = [System.IO.Path]::GetFileNameWithoutExtension($outputBase)
$captures = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter "$stem*.csv" |
    Sort-Object LastWriteTime -Descending)

if ($captures.Count -eq 0) {
    throw "No trace was written. Run again and press $Hotkey once to start and once to stop."
}

$latest = $captures[0]
$latestCopy = Join-Path $env:LOCALAPPDATA "Temp\dolphin-stutter-latest.csv"
Copy-Item -LiteralPath $latest.FullName -Destination $latestCopy -Force

Write-Host ""
Write-Host "Capture complete: $($latest.FullName)"
Write-Host "Analysis copy: $latestCopy"
Write-Host "Tell Codex 'trace captured' and it can analyze the file directly."
