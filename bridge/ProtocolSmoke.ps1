param([Alias("Bridge")][string]$BridgePath = "$PSScriptRoot/bin/Release/net8.0-windows/win-x64/dsh-vs-bridge.exe")
$ErrorActionPreference = 'Stop'
# No discover/connect: this test does not inspect or manipulate Visual Studio.
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Resolve-Path $BridgePath).Path
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$started=$false
try {
    [void]$process.Start(); $started=$true
    $records = @(
        '{"protocol":1,"id":"status","method":"status","params":{}}',
        '{"protocol":1,"id":"unknown","method":"bogus","params":{}}',
        '{"protocol":1,"id":"fields","method":"status","params":{"unknown":1}}',
        '{"protocol":1,"id":"duplicate","method":"status","params":{},"params":{}}',
        ('x' * 65537),
        '{"protocol":1,"id":"after","method":"disconnect","params":{}}',
        '{"protocol":1,"id":"mutate","method":"launch","params":{}}'
    )
    # Drain each response before writing the next large record to avoid pipe deadlock.
    $responses = @()
    foreach ($record in $records) {
        $process.StandardInput.WriteLine($record)
        $process.StandardInput.Flush()
        $read = $process.StandardOutput.ReadLineAsync()
        if (-not $read.Wait(10000)) { throw 'Bridge did not respond in 10 seconds' }
        $responses += ($read.Result | ConvertFrom-Json)
    }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(10000)) { throw 'Bridge did not exit on EOF' }
    if ($process.ExitCode -ne 0) { throw ('Bridge exited ' + $process.ExitCode) }
    if (-not $responses[0].ok -or $responses[0].value.state -ne 'disconnected') { throw 'Disconnected status failed' }
    if ($responses[1].error.code -ne 'UNKNOWN_METHOD') { throw 'Unknown method accepted' }
    foreach ($index in @(2,3,4)) { if ($responses[$index].error.code -ne 'INVALID_REQUEST') { throw 'Invalid input accepted' } }
    if (-not $responses[5].ok -or $responses[5].id -ne 'after') { throw 'Oversized record lost framing' }
    if ($responses[6].error.code -ne 'DISCONNECTED') { throw 'Unbound mutation accepted' }
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); if(-not $process.WaitForExit(10000)){throw 'Bridge cleanup timeout; NOT PASS'} }
    $process.Dispose()
}
Write-Output 'PASS: 7 protocol records; unknown fields/methods, duplicate fields, oversized framing, disconnected mutation, EOF; no VS calls'
