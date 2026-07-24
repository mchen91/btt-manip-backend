param(
    [ValidateRange(0, 30)]
    [int]$DelaySeconds = 0,

    [ValidateRange(1, 30)]
    [int]$DurationSeconds = 5,

    [ValidateRange(25, 1000)]
    [int]$IntervalMilliseconds = 100,

    [ValidateRange(25, 2000)]
    [int]$MessageTimeoutMilliseconds = 200
)

$ErrorActionPreference = "Stop"

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DolphinWindowProbe
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        UIntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern uint GetGuiResources(IntPtr process, uint flags);
}
"@

$dolphin = Get-Process -Name "Dolphin" -ErrorAction Stop | Sort-Object StartTime -Descending | Select-Object -First 1
$dolphin.Refresh()
$mainWindow = $dolphin.MainWindowHandle
if ($mainWindow -eq [IntPtr]::Zero) {
    throw "Dolphin does not currently have a main window handle."
}
$mainWindowPid = [uint32]0
$mainWindowThreadId = [DolphinWindowProbe]::GetWindowThreadProcessId($mainWindow, [ref]$mainWindowPid)

$foregroundHandle = [DolphinWindowProbe]::GetForegroundWindow()
$foregroundPid = [uint32]0
[DolphinWindowProbe]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) | Out-Null
$foreground = Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue

$threadCpuBefore = @{}
foreach ($thread in @($dolphin.Threads)) {
    try { $threadCpuBefore[$thread.Id] = $thread.TotalProcessorTime.TotalMilliseconds } catch {}
}

$latencies = [System.Collections.Generic.List[double]]::new()
$timeouts = 0
$probeClock = [System.Diagnostics.Stopwatch]::StartNew()
while ($probeClock.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $callClock = [System.Diagnostics.Stopwatch]::StartNew()
    $messageResult = [UIntPtr]::Zero
    $sent = [DolphinWindowProbe]::SendMessageTimeout(
        $mainWindow,
        0,
        [UIntPtr]::Zero,
        [IntPtr]::Zero,
        2,
        $MessageTimeoutMilliseconds,
        [ref]$messageResult
    )
    $callClock.Stop()
    $latencies.Add($callClock.Elapsed.TotalMilliseconds)
    if ($sent -eq [IntPtr]::Zero) { $timeouts++ }

    $remaining = $IntervalMilliseconds - [int]$callClock.Elapsed.TotalMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
}

$dolphin.Refresh()
$threadDetails = foreach ($thread in @($dolphin.Threads)) {
    if (-not $threadCpuBefore.ContainsKey($thread.Id)) { continue }
    try {
        $cpuDelta = $thread.TotalProcessorTime.TotalMilliseconds - $threadCpuBefore[$thread.Id]
        $waitReason = $null
        if ($thread.ThreadState -eq [System.Diagnostics.ThreadState]::Wait) {
            try { $waitReason = [string]$thread.WaitReason } catch {}
        }
        [pscustomobject]@{
            ThreadId = $thread.Id
            CpuMilliseconds = [Math]::Round($cpuDelta, 2)
            CpuOfOneCorePercent = [Math]::Round(100.0 * $cpuDelta / ($DurationSeconds * 1000.0), 2)
            State = [string]$thread.ThreadState
            WaitReason = $waitReason
            PriorityLevel = [string]$thread.PriorityLevel
        }
    } catch {}
}

$hookModules = @($dolphin.Modules | Where-Object {
    $_.ModuleName -match '(?i)hook|overlay|obs|gamebar|discord|rtss|radeon|amd|capture'
} | ForEach-Object {
    [pscustomobject]@{
        Name = $_.ModuleName
        Path = $_.FileName
    }
})

$latencyValues = @($latencies)
[pscustomobject]@{
    CapturedAt = (Get-Date).ToString("o")
    ProcessId = $dolphin.Id
    UptimeMinutes = [Math]::Round(((Get-Date) - $dolphin.StartTime).TotalMinutes, 1)
    Responding = $dolphin.Responding
    PriorityClass = [string]$dolphin.PriorityClass
    ProcessorAffinity = "0x{0:X}" -f [long]$dolphin.ProcessorAffinity
    WorkingSetMiB = [Math]::Round($dolphin.WorkingSet64 / 1MB, 1)
    PrivateMiB = [Math]::Round($dolphin.PrivateMemorySize64 / 1MB, 1)
    HandleCount = $dolphin.HandleCount
    ThreadCount = $dolphin.Threads.Count
    GdiObjects = [DolphinWindowProbe]::GetGuiResources($dolphin.Handle, 0)
    UserObjects = [DolphinWindowProbe]::GetGuiResources($dolphin.Handle, 1)
    MainWindowThreadId = $mainWindowThreadId
    MainWindowTitle = $dolphin.MainWindowTitle
    ForegroundProcess = if ($foreground) { $foreground.ProcessName } else { $null }
    ForegroundWindowTitle = if ($foreground) { $foreground.MainWindowTitle } else { $null }
    MessageProbe = [pscustomobject]@{
        Samples = $latencyValues.Count
        Timeouts = $timeouts
        MeanMilliseconds = [Math]::Round(($latencyValues | Measure-Object -Average).Average, 3)
        MaxMilliseconds = [Math]::Round(($latencyValues | Measure-Object -Maximum).Maximum, 3)
    }
    HookAndOverlayModules = $hookModules
    TopThreads = @($threadDetails | Sort-Object CpuMilliseconds -Descending | Select-Object -First 12)
} | ConvertTo-Json -Depth 5
