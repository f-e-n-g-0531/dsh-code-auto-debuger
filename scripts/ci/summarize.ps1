[CmdletBinding()]
param([Parameter(Mandatory)][string]$Context)
$ErrorActionPreference = 'Stop'
$status = if ($env:JOB_STATUS) { $env:JOB_STATUS } else { 'unknown' }
$lines = @("## $Context", '', "Status: **$status**", '', 'Artifacts are candidates only. No npm publish, GitHub Release, VSIX installation or production installation is performed.', 'Hosted build/package success does not attest to real Visual Studio integration.')
$package = Get-Content 'package.json' -Raw | ConvertFrom-Json
$artifactDir = if ($env:DSH_AUTO_DEBUG_ARTIFACT_DIR) { $env:DSH_AUTO_DEBUG_ARTIFACT_DIR } else { Join-Path '.artifacts' $package.version }
$manifestPath = Join-Path $artifactDir 'manifest.json'
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $lines += @('', "Candidate version: $($manifest.version)", "SHA-256: $($manifest.sha256)")
}
$lines | Write-Output
if ($env:GITHUB_STEP_SUMMARY) { $lines | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append }
if ($status -notin @('success', 'failure', 'cancelled', 'unknown')) { throw 'Unexpected job status.' }
