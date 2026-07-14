param(
    [ValidateRange(3, 300)]
    [int]$DurationSeconds = 15,

    [ValidateRange(1, 10)]
    [int]$IntervalSeconds = 1,

    [switch]$SkipGpu,

    [switch]$SkipSystemCpu
)

$ErrorActionPreference = "Stop"
$targetNames = @("Dolphin", "obs64", "msedge", "m-protocold")
$logicalProcessors = [Environment]::ProcessorCount
$previousCpu = @{}
$samples = [System.Collections.Generic.List[object]]::new()
$perPidSamples = [System.Collections.Generic.List[object]]::new()
$gpuAvailable = -not $SkipGpu
$startedAt = Get-Date
$edgeMetadata = @{}

try {
    foreach ($edgeProcess in @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")) {
        $commandLine = [string]$edgeProcess.CommandLine
        $role = 'Browser'
        if ($commandLine -match '--type=([^ ]+)') { $role = $Matches[1] }
        if ($commandLine -match '--utility-sub-type=([^ ,]+)') { $role = "utility:$($Matches[1])" }
        $edgeMetadata[[int]$edgeProcess.ProcessId] = [pscustomobject]@{
            ParentProcessId = [int]$edgeProcess.ParentProcessId
            Role = $role
            IsApp = $commandLine -match '--app-id='
        }
    }
}
catch {}

function Get-TargetProcesses {
    @(Get-Process -Name $targetNames -ErrorAction SilentlyContinue)
}

function Get-GpuUsageByTarget([hashtable]$PidToTarget) {
    $result = @{}
    if (-not $script:gpuAvailable) { return $result }

    try {
        $paths = @($PidToTarget.Keys | ForEach-Object {
            "\GPU Engine(pid_$($_)_*)\Utilization Percentage"
        })
        if ($paths.Count -eq 0) { return $result }
        $counter = Get-Counter -Counter $paths
    }
    catch {
        $script:gpuAvailable = $false
        return $result
    }

    foreach ($counterSample in $counter.CounterSamples) {
        $instance = $counterSample.InstanceName
        if ($instance -notmatch 'pid_(\d+).*engtype_(.+)$') { continue }

        $pidNumber = [int]$Matches[1]
        $engine = $Matches[2]
        if (-not $PidToTarget.ContainsKey($pidNumber)) { continue }

        $key = "{0}|{1}" -f $PidToTarget[$pidNumber], $engine
        if (-not $result.ContainsKey($key)) { $result[$key] = 0.0 }
        $result[$key] += [double]$counterSample.CookedValue
    }

    return $result
}

$initial = Get-TargetProcesses
foreach ($process in $initial) {
    $previousCpu[$process.Id] = [double]$process.CPU
}
$previousSampleAt = Get-Date

$sampleCount = [Math]::Max(1, [Math]::Floor($DurationSeconds / $IntervalSeconds))
for ($sampleIndex = 0; $sampleIndex -lt $sampleCount; $sampleIndex++) {
    Start-Sleep -Seconds $IntervalSeconds
    $processes = Get-TargetProcesses
    $sampledAt = Get-Date
    $elapsedSeconds = [Math]::Max(0.001, ($sampledAt - $previousSampleAt).TotalSeconds)
    $previousSampleAt = $sampledAt
    $pidToTarget = @{}
    foreach ($process in $processes) { $pidToTarget[$process.Id] = $process.ProcessName }

    $gpu = if ($SkipGpu) { @{} } else { Get-GpuUsageByTarget $pidToTarget }
    $cpuByTarget = @{}
    $workingSetByTarget = @{}
    $privateBytesByTarget = @{}

    foreach ($process in $processes) {
        $name = $process.ProcessName
        $currentCpu = [double]$process.CPU
        $cpuPercent = 0.0
        if ($previousCpu.ContainsKey($process.Id)) {
            $cpuDelta = [Math]::Max(0.0, $currentCpu - $previousCpu[$process.Id])
            $cpuPercent = ($cpuDelta / $elapsedSeconds) * 100.0 / $logicalProcessors
        }
        $previousCpu[$process.Id] = $currentCpu

        $perPidSamples.Add([pscustomobject]@{
            Second = ($sampleIndex + 1) * $IntervalSeconds
            Process = $name
            ProcessId = $process.Id
            CpuPercent = [Math]::Round($cpuPercent, 2)
            WorkingSetMiB = [Math]::Round($process.WorkingSet64 / 1MB, 1)
            PrivateMiB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
            MainWindowTitle = [string]$process.MainWindowTitle
        })

        if (-not $cpuByTarget.ContainsKey($name)) {
            $cpuByTarget[$name] = 0.0
            $workingSetByTarget[$name] = 0L
            $privateBytesByTarget[$name] = 0L
        }
        $cpuByTarget[$name] += $cpuPercent
        $workingSetByTarget[$name] += [long]$process.WorkingSet64
        $privateBytesByTarget[$name] += [long]$process.PrivateMemorySize64
    }

    $systemCpu = $null
    if (-not $SkipSystemCpu) {
        try {
            $systemCpu = [double](Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples[0].CookedValue
        }
        catch {}
    }

    foreach ($name in $targetNames) {
        if (-not $cpuByTarget.ContainsKey($name)) { continue }
        $gpuForTarget = @{}
        foreach ($key in $gpu.Keys) {
            if ($key.StartsWith("$name|", [System.StringComparison]::OrdinalIgnoreCase)) {
                $gpuForTarget[$key.Substring($name.Length + 1)] = [Math]::Round($gpu[$key], 2)
            }
        }

        $samples.Add([pscustomobject]@{
            Second = ($sampleIndex + 1) * $IntervalSeconds
            Process = $name
            CpuPercent = [Math]::Round($cpuByTarget[$name], 2)
            WorkingSetMiB = [Math]::Round($workingSetByTarget[$name] / 1MB, 1)
            PrivateMiB = [Math]::Round($privateBytesByTarget[$name] / 1MB, 1)
            SystemCpuPercent = if ($null -eq $systemCpu) { $null } else { [Math]::Round($systemCpu, 2) }
            GpuEngines = $gpuForTarget
        })
    }
}

$summary = foreach ($name in $targetNames) {
    $targetSamples = @($samples | Where-Object Process -eq $name)
    if ($targetSamples.Count -eq 0) { continue }

    $gpuEngineNames = @($targetSamples | ForEach-Object { $_.GpuEngines.Keys } | Sort-Object -Unique)
    $gpuSummary = @{}
    foreach ($engine in $gpuEngineNames) {
        $values = @($targetSamples | ForEach-Object {
            if ($_.GpuEngines.ContainsKey($engine)) { [double]$_.GpuEngines[$engine] } else { 0.0 }
        })
        $gpuSummary[$engine] = [pscustomobject]@{
            MeanPercent = [Math]::Round(($values | Measure-Object -Average).Average, 2)
            MaxPercent = [Math]::Round(($values | Measure-Object -Maximum).Maximum, 2)
        }
    }

    [pscustomobject]@{
        Process = $name
        MeanCpuPercent = [Math]::Round(($targetSamples.CpuPercent | Measure-Object -Average).Average, 2)
        MaxCpuPercent = [Math]::Round(($targetSamples.CpuPercent | Measure-Object -Maximum).Maximum, 2)
        MeanWorkingSetMiB = [Math]::Round(($targetSamples.WorkingSetMiB | Measure-Object -Average).Average, 1)
        MeanPrivateMiB = [Math]::Round(($targetSamples.PrivateMiB | Measure-Object -Average).Average, 1)
        GpuEngines = $gpuSummary
    }
}

$systemSamples = @($samples | Where-Object { $null -ne $_.SystemCpuPercent } | Select-Object -ExpandProperty SystemCpuPercent)
$processDetails = @($perPidSamples | Group-Object ProcessId | ForEach-Object {
    $pidSamples = @($_.Group)
    $pidNumber = [int]$_.Name
    $metadata = if ($edgeMetadata.ContainsKey($pidNumber)) { $edgeMetadata[$pidNumber] } else { $null }
    [pscustomobject]@{
        Process = $pidSamples[0].Process
        ProcessId = $pidNumber
        ParentProcessId = if ($metadata) { $metadata.ParentProcessId } else { $null }
        Role = if ($metadata) { $metadata.Role } else { $null }
        IsEdgeAppProcess = if ($metadata) { $metadata.IsApp } else { $false }
        MeanCpuPercent = [Math]::Round(($pidSamples.CpuPercent | Measure-Object -Average).Average, 2)
        MaxCpuPercent = [Math]::Round(($pidSamples.CpuPercent | Measure-Object -Maximum).Maximum, 2)
        MeanWorkingSetMiB = [Math]::Round(($pidSamples.WorkingSetMiB | Measure-Object -Average).Average, 1)
        MainWindowTitle = @($pidSamples.MainWindowTitle | Where-Object { $_ } | Select-Object -First 1)[0]
    }
} | Sort-Object Process, @{ Expression = 'MeanCpuPercent'; Descending = $true })
$obsLagLines = @()
$obsLogName = $null
try {
    $obsLogDir = Join-Path $env:APPDATA 'obs-studio\logs'
    $latestObsLog = Get-ChildItem $obsLogDir -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestObsLog) {
        $obsLogName = $latestObsLog.Name
        $obsLagLines = @(Select-String -Path $latestObsLog.FullName -Pattern 'lagged frames|skipped frames due to encoding lag|video settings reset|output resolution|fps:|encoder|recording|adv_file_output|ffmpeg muxer|bitrate' |
            Select-Object -Last 50 | ForEach-Object { $_.Line.Trim() })
    }
}
catch {}

$videoControllers = @()
try {
    $videoControllers = @(Get-CimInstance Win32_VideoController | ForEach-Object {
        [pscustomobject]@{
            Name = $_.Name
            DriverVersion = $_.DriverVersion
        }
    })
}
catch {}

[pscustomobject]@{
    StartedAt = $startedAt.ToString('o')
    RequestedDurationSeconds = $DurationSeconds
    ActualElapsedSeconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    LogicalProcessors = $logicalProcessors
    GpuCountersAvailable = $gpuAvailable
    MeanSystemCpuPercent = if ($systemSamples.Count -eq 0) { $null } else { [Math]::Round(($systemSamples | Measure-Object -Average).Average, 2) }
    MaxSystemCpuPercent = if ($systemSamples.Count -eq 0) { $null } else { [Math]::Round(($systemSamples | Measure-Object -Maximum).Maximum, 2) }
    VideoControllers = $videoControllers
    Processes = @($summary)
    ProcessDetails = $processDetails
    ObsLogName = $obsLogName
    ObsLagLogLines = $obsLagLines
    Samples = @($samples)
} | ConvertTo-Json -Depth 8
