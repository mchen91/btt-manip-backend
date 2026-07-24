param(
    [ValidateRange(1, 120)]
    [int]$WatchMinutes = 35,

    [ValidateRange(10, 300)]
    [int]$IntervalSeconds = 30,

    [ValidateRange(1, 10)]
    [int]$ProbeSeconds = 2,

    [string]$LogPath = (Join-Path $env:LOCALAPPDATA "Temp\dolphin-responsiveness-watch.jsonl")
)

$ErrorActionPreference = "Continue"
$probePath = Join-Path $PSScriptRoot "probe_dolphin_responsiveness.ps1"
$initialDolphin = Get-Process -Name "Dolphin" -ErrorAction Stop | Sort-Object StartTime -Descending | Select-Object -First 1
$initialPid = $initialDolphin.Id
$sampleCount = [Math]::Ceiling(($WatchMinutes * 60.0) / $IntervalSeconds)
$consecutiveRed = 0

Remove-Item -LiteralPath $LogPath -Force -ErrorAction SilentlyContinue

for ($index = 0; $index -lt $sampleCount; $index++) {
    $currentDolphin = Get-Process -Id $initialPid -ErrorAction SilentlyContinue
    if (-not $currentDolphin) {
        [pscustomobject]@{
            CapturedAt = (Get-Date).ToString("o")
            Status = "process-exited"
            ProcessId = $initialPid
        } | ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath
        break
    }

    try {
        $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probePath `
            -DurationSeconds $ProbeSeconds 2>$null | Out-String
        $probe = $raw | ConvertFrom-Json
        $mainThread = @($probe.TopThreads | Where-Object ThreadId -eq $probe.MainWindowThreadId | Select-Object -First 1)[0]
        $hooked = @($probe.HookAndOverlayModules | Where-Object Name -eq "graphics-hook64.dll").Count -gt 0
        $red = $probe.MessageProbe.MeanMilliseconds -ge 40 -or $probe.MessageProbe.Timeouts -gt 0
        if ($red) { $consecutiveRed++ } else { $consecutiveRed = 0 }

        $summary = [pscustomobject]@{
            CapturedAt = $probe.CapturedAt
            Status = if ($consecutiveRed -ge 2) { "degraded" } elseif ($red) { "warning" } else { "responsive" }
            ProcessId = $probe.ProcessId
            UptimeMinutes = $probe.UptimeMinutes
            MeanMessageMilliseconds = $probe.MessageProbe.MeanMilliseconds
            MaxMessageMilliseconds = $probe.MessageProbe.MaxMilliseconds
            Timeouts = $probe.MessageProbe.Timeouts
            MainThreadCpuPercent = if ($mainThread) { $mainThread.CpuOfOneCorePercent } else { $null }
            ObsHookInjected = $hooked
            WorkingSetMiB = $probe.WorkingSetMiB
            PrivateMiB = $probe.PrivateMiB
            HandleCount = $probe.HandleCount
            ThreadCount = $probe.ThreadCount
        }
        $summary | ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath
        $summary | ConvertTo-Json -Compress

        if ($consecutiveRed -eq 2) {
            try { [Console]::Beep(1100, 500) } catch {}
        }
    }
    catch {
        [pscustomobject]@{
            CapturedAt = (Get-Date).ToString("o")
            Status = "probe-error"
            ProcessId = $initialPid
            Error = $_.Exception.Message
        } | ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath
    }

    if ($index -lt $sampleCount - 1) { Start-Sleep -Seconds $IntervalSeconds }
}
