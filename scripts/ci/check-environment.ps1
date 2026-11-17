[CmdletBinding()]
param([switch]$RequireInteractive)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows is required.' }
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "Node.js 22 is required; found $nodeVersion" }
$sdks = & dotnet --list-sdks
if ($LASTEXITCODE -ne 0 -or -not ($sdks -match '^8\.')) { throw '.NET SDK 8 is required.' }
if ($RequireInteractive) {
    if (-not [Environment]::UserInteractive) { throw 'An interactive Windows session is required.' }
    $sessionId = (Get-Process -Id $PID).SessionId
    if ($sessionId -eq 0 -or -not (Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sessionId)) {
        throw 'Runner must run in a logged-in desktop session, not as a service.'
    }
    if ($env:DSH_AUTO_DEBUG_INTEGRATION -ne '1') { throw 'Explicit integration opt-in is required.' }
    if (-not $env:DSH_AUTO_DEBUG_VS_INSTANCE -or -not $env:DSH_AUTO_DEBUG_SOLUTION) { throw 'VS instance and dedicated solution must be set.' }
}
Write-Host "Environment passed: Windows, Node $nodeVersion, .NET SDK 8; interactive=$RequireInteractive"
