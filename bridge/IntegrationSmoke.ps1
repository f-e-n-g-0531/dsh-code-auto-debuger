param([switch]$AllowNewVisualStudioFixture, [switch]$NativeFixture, [Alias('Bridge')][string]$BridgePath, [switch]$ExtendedCommands, [string]$Marker = 'BREAKPOINT:', [string]$ExpectedFunction = 'Add', [string]$FixtureSolution, [string]$VisualStudio = 'C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/devenv.exe')
$ErrorActionPreference = 'Stop'
if (-not $AllowNewVisualStudioFixture) { throw 'Explicit -AllowNewVisualStudioFixture required: starts and controls a new fixture-only VS instance' }
$root = Split-Path $PSScriptRoot
$solution = Join-Path $root 'test/fixtures/csharp/DebugFixture.sln'
$source = Join-Path $root 'test/fixtures/csharp/Program.cs'
if ($NativeFixture) { $solution=Join-Path $root 'test/fixtures/cpp/build/DshDebugFixture.sln'; $source=Join-Path $root 'test/fixtures/cpp/main.cpp' }
if ($FixtureSolution) { $candidate=(Resolve-Path -LiteralPath $FixtureSolution).Path; $fixtureRoot=(Resolve-Path (Join-Path $root 'test/fixtures')).Path + [IO.Path]::DirectorySeparatorChar; if(-not $candidate.StartsWith($fixtureRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Only fixture solutions permitted'}; $solution=$candidate }
$exe = Join-Path $PSScriptRoot 'bin/Release/net8.0-windows/win-x64/dsh-vs-bridge.exe'
if ($BridgePath) { $exe=(Resolve-Path $BridgePath).Path }
if (-not (Test-Path $solution)) { throw 'Create fixture solution before integration' }
$matches = @(Select-String -LiteralPath $source -SimpleMatch $Marker)
if ($matches.Count -ne 1) { throw 'Marker must identify exactly one source line' }
$line = $matches[0].LineNumber
$vs=$null; $bridgeProcess=$null; $ownedStart=$null; $sequence=0
$ownedChildren=@{}; $cleanupErrors=[Collections.Generic.List[string]]::new()
function Capture-OwnedChildren {
    if (-not $vs -or -not $ownedStart) { return }
    # Traverse only descendants of this exact newly-created VS; never status.debuggees
    # or a process-name match. Retain creation identities even after reparenting.
    $all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    $parents=@{}
    $identities=@{}; $identities[$vs.Id]=$ownedStart
    foreach($entry in $ownedChildren.GetEnumerator()) { $identities[$entry.Key]=$entry.Value }
    foreach($item in $all) {
        $identityId=[int]$item.ProcessId
        if($identities.ContainsKey($identityId)) {
            $actual=Get-Process -Id $identityId -ErrorAction SilentlyContinue
            if($actual) { try {
                if($actual.StartTime.ToUniversalTime().Ticks -eq $identities[$identityId].Ticks) { $parents[$identityId]=$identities[$identityId] }
            } finally { $actual.Dispose() } }
        }
    }
    do {
        $changed=$false
        foreach ($item in $all) {
            $childId=[int]$item.ProcessId; $parentId=[int]$item.ParentProcessId
            if ($parents.ContainsKey($parentId) -and -not $parents.ContainsKey($childId)) {
                $created=$item.CreationDate.ToUniversalTime()
                if ($created -lt $parents[$parentId]) { continue }
                $p=Get-Process -Id $childId -ErrorAction SilentlyContinue
                if (-not $p) { continue }
                try {
                    $exactTicks=$p.StartTime.ToUniversalTime().Ticks
                    $microTicks=$exactTicks-($exactTicks % 10)
                    if ($microTicks -ne ($created.Ticks-($created.Ticks % 10))) { throw 'CIM/process microsecond start mismatch' }
                    $parents[$childId]=$p.StartTime.ToUniversalTime()
                    $ownedChildren[$childId]=$parents[$childId]; $changed=$true
                } finally { $p.Dispose() }
            }
        }
    } while ($changed)
}
function Stop-Exact($processId, $startTime) {
    $p=Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $p) { return }
    try {
        if ($p.StartTime.ToUniversalTime().Ticks -ne $startTime.Ticks) { throw "Cleanup refused changed PID=$processId" }
        $p.Kill() # process handle, not a name-based kill or unchecked reused PID
        if (-not $p.WaitForExit(10000)) { throw "Cleanup timeout PID=$processId" }
    } finally { $p.Dispose() }
}
function Call($method, $parameters=@{}) {
    $script:sequence++
    $bridgeProcess.StandardInput.WriteLine((@{protocol=1;id=$script:sequence;method=$method;params=$parameters}|ConvertTo-Json -Compress -Depth 16))
    $bridgeProcess.StandardInput.Flush()
    $read=$bridgeProcess.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(35000)) { throw "Timeout $method; unknown outcome, do not replay" }
    if ($null -eq $read.Result) { throw "EOF $method" }
    $response=$read.Result|ConvertFrom-Json
    if ($response.id -ne $script:sequence -or $response.protocol -ne 1) { throw 'Response identity mismatch' }
    if (-not $response.ok -and $method -in @('status','connect','discover') -and $response.error.code -in @('BUSY','TARGET_NOT_FOUND')) { return @{state='busy'} }
    if (-not $response.ok) { throw ($method + ': ' + ($response.error|ConvertTo-Json -Compress)) }
    Write-Host ($method + ': ' + ($response.value|ConvertTo-Json -Compress -Depth 16))
    return $response.value
}
function Wait-State($expected) {
    $deadline=[datetime]::UtcNow.AddSeconds(45)
    do { Capture-OwnedChildren; $state=Call 'status'; if ($state.state -eq $expected) { return }; Start-Sleep -Milliseconds 400 } while ([datetime]::UtcNow -lt $deadline)
    throw "Expected state $expected"
}
try {
    # Every creation is protected, including failure to configure/start the bridge.
    $vs = Start-Process -FilePath $VisualStudio -ArgumentList ('"' + $solution + '" /NoSplash') -PassThru
    $ownedStart = $vs.StartTime.ToUniversalTime()
    $si = [Diagnostics.ProcessStartInfo]::new($exe)
    $si.UseShellExecute=$false; $si.RedirectStandardInput=$true; $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true
    $bridgeProcess = [Diagnostics.Process]::new(); $bridgeProcess.StartInfo=$si
    [void]$bridgeProcess.Start()
    $bridgeDiagnostics=$bridgeProcess.StandardError.ReadToEndAsync()
    Write-Host "Owned VS PID=$($vs.Id) start=$($ownedStart.ToString('O'))"
    $deadline=[datetime]::UtcNow.AddSeconds(45); $instance=$null
    do {
        Capture-OwnedChildren
        $instances=Call 'discover'
        $instance=$instances.instances|Where-Object {$_.pid -eq $vs.Id -and $_.solutionPath -eq $solution -and [datetime]$_.startTime -eq $ownedStart}|Select-Object -First 1
        if ($instance) { break }; Start-Sleep -Milliseconds 800
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $instance) { throw 'Owned VS did not publish exact fixture identity in ROT' }
    $deadline=[datetime]::UtcNow.AddSeconds(30)
    do { $connected=Call 'connect' @{instanceId=$instance.instanceId;solutionPath=$solution}; if($connected.state -ne 'busy'){break}; Start-Sleep -Milliseconds 500 } while([datetime]::UtcNow -lt $deadline)
    if($connected.state -ne 'design'){throw 'Fixture must connect in design mode'}
    # Give asynchronous solution load four bounded read-only observations; no mutation replay.
    for($ready=0;$ready -lt 4;$ready++){ [void](Call 'status'); Start-Sleep -Milliseconds 750 }
    $bp=Call 'breakpointAdd' @{file=$source;line=$line}
    if (-not $bp.created -or -not $bp.breakpointId) { throw 'New breakpoint identity missing; inspect before retry' }
    [void](Call 'launch'); Wait-State 'break'
    $snapshot=Call 'snapshot'
    if ($snapshot.stack.Count -eq 0 -or $snapshot.variablesEvaluated -or $snapshot.stack[0].function -notmatch [regex]::Escape($ExpectedFunction)) { throw 'Expected function not observed' }
    if (-not $snapshot.position -or $snapshot.position.file -ine $source -or $snapshot.position.line -ne $line) { throw 'not_verified: newly-created breakpoint source/line hit not proven' }
    [void](Call 'step' @{kind='over'}); Wait-State 'break'
    $after=Call 'snapshot'
    $advanced=$after.position -and $after.position.file -and $after.position.line -gt 0 -and ($after.position.file -ine $snapshot.position.file -or $after.position.line -ne $snapshot.position.line)
    if (-not $advanced) { throw 'not_verified: step returned but source/instruction advancement not proven' }
    [void](Call 'breakpointRemove' @{breakpointId=$bp.breakpointId})
    $remaining=Call 'listOwnedBreakpoints'
    if (@($remaining.breakpoints|Where-Object {$_.breakpointId -eq $bp.breakpointId}).Count) { throw 'Breakpoint deletion postcondition failed' }
    if ($ExtendedCommands) {
        [void](Call 'continue'); Wait-State 'running'
        [void](Call 'pause'); Wait-State 'break'
        [void](Call 'snapshot')
        [void](Call 'terminate'); Wait-State 'design'
    }
    [void](Call 'disconnect')
} finally {
    try { Capture-OwnedChildren } catch { $cleanupErrors.Add('Capture: '+$_.Exception.Message) }
    if ($bridgeProcess) {
        try {
            if ($bridgeProcess.Id -and -not $bridgeProcess.HasExited) {
                $bridgeProcess.StandardInput.Close()
                if (-not $bridgeProcess.WaitForExit(5000)) { $bridgeProcess.Kill(); if (-not $bridgeProcess.WaitForExit(10000)) { throw 'Bridge cleanup timeout' } }
            }
            if ($bridgeDiagnostics) { Write-Host ('Bridge diagnostics: '+$bridgeDiagnostics.GetAwaiter().GetResult()) }
        } catch { $cleanupErrors.Add('Bridge: '+$_.Exception.Message) }
        finally { $bridgeProcess.Dispose() }
    }
    $clean=$false
    for($round=0; $round -lt 12; $round++) {
        try { Capture-OwnedChildren } catch { $cleanupErrors.Add($_.Exception.Message); break }
        $targets=@{}; foreach($entry in $ownedChildren.GetEnumerator()) { $targets[$entry.Key]=$entry.Value }
        if($vs -and $ownedStart) { $targets[$vs.Id]=$ownedStart }
        $live=@()
        foreach($entry in $targets.GetEnumerator()) {
            $p=Get-Process -Id $entry.Key -ErrorAction SilentlyContinue
            if($p) { try {
                if($p.StartTime.ToUniversalTime().Ticks -eq $entry.Value.Ticks) { $live+=,$entry }
                else { $cleanupErrors.Add('Cleanup refused changed identity PID='+$entry.Key) }
            } finally { $p.Dispose() } }
        }
        if(-not $live.Count) { $clean=$true; break }
        foreach($entry in ($live|Sort-Object { if($vs -and $_.Key -eq $vs.Id){0}else{1} })) {
            try { Capture-OwnedChildren; Stop-Exact $entry.Key $entry.Value } catch { $cleanupErrors.Add($_.Exception.Message) }
        }
    }
    if(-not $clean) { $cleanupErrors.Add('Cleanup did not reach verified no-live-owned state') }
    if($vs) { $vs.Dispose() }
    if ($cleanupErrors.Count) { throw ('Cleanup failed (NOT PASS): '+($cleanupErrors -join '; ')) }
}
Write-Host 'PASS live fixture: exact breakpoint hit, expected function, source advancement, deletion postquery, disconnect and owned cleanup verified'
