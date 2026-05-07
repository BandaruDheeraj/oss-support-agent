<#
.SYNOPSIS
    Ralph autonomous agent loop for AI-driven development via GitHub Copilot CLI.

.DESCRIPTION
    Implements the soderlind/ralph pattern: AI reads PRD -> implements one feature
    -> verifies -> updates PRD -> commits -> repeats until <promise>COMPLETE</promise>.

.PARAMETER Iterations
    Maximum number of iterations to run. Default: 25.

.PARAMETER Model
    Model identifier passed to copilot. Default: gpt-5.2.

.PARAMETER AllowProfile
    Tool permission profile: safe | dev | locked. Default: safe.

.PARAMETER DryRun
    Print the copilot command for each iteration without executing it.

.PARAMETER PrdFile
    Path to the PRD JSON file Ralph should drive against. Accepts an absolute path,
    a path relative to the project root, a bare filename in scripts/ralph/, or a
    short name without extension (e.g. 'extensibility' -> scripts/ralph/prd-extensibility.json).
    Default: scripts/ralph/prd.json

.EXAMPLE
    .\ralph.ps1 -Iterations 10 -Model gpt-5.2 -AllowProfile dev

.EXAMPLE
    .\ralph.ps1 -PrdFile extensibility            # uses scripts/ralph/prd-extensibility.json

.EXAMPLE
    .\ralph.ps1 -PrdFile scripts\ralph\prd-extensibility.json
#>
[CmdletBinding()]
param(
    [int]$Iterations = 25,
    [string]$Model = "gpt-5.2",
    [ValidateSet("safe", "dev", "locked")]
    [string]$AllowProfile = "safe",
    [switch]$DryRun,
    [string]$PrdFile = "scripts\ralph\prd.json"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Get-Location).Path

# Resolve $PrdFile flexibly: absolute, project-relative, bare filename in scripts/ralph/,
# or short name (e.g. 'extensibility' -> scripts/ralph/prd-extensibility.json).
function Resolve-PrdPath {
    param([string]$Path, [string]$Root)
    $candidates = @()
    if ([System.IO.Path]::IsPathRooted($Path)) {
        $candidates += $Path
    }
    $candidates += (Join-Path $Root $Path)
    $candidates += (Join-Path $Root (Join-Path "scripts\ralph" $Path))
    if ($Path -notlike "*.json") {
        $short = $Path
        if ($short -notlike "prd*") { $short = "prd-$short" }
        $candidates += (Join-Path $Root (Join-Path "scripts\ralph" "$short.json"))
    }
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and -not (Test-Path $c -PathType Container)) {
            return (Resolve-Path $c).Path
        }
    }
    throw "PRD file not found. Tried:`n  - $($candidates -join "`n  - ")"
}

$PrdFile     = Resolve-PrdPath -Path $PrdFile -Root $ProjectRoot
$ProgressFile= Join-Path $ProjectRoot "progress.txt"
$PromptFile  = Join-Path $ProjectRoot "prompts\default.txt"

foreach ($f in @($ProgressFile, $PromptFile)) {
    if (-not (Test-Path $f)) { throw "Required file missing: $f" }
}

# Tool permission profiles. We always deny destructive shell ops.
$denyAlways = @('shell(rm)', 'shell(git push)')

switch ($AllowProfile) {
    "safe" {
        $allow = @('write', 'shell(git:*)', 'shell(npm:*)', 'shell(node:*)', 'shell(python:*)', 'shell(pwsh:*)')
        $deny  = $denyAlways
    }
    "dev" {
        $allow = @('write', 'shell')
        $deny  = $denyAlways
    }
    "locked" {
        $allow = @('write')
        $deny  = $denyAlways + @('shell')
    }
}

$toolArgs = @()
foreach ($a in $allow) { $toolArgs += @('--allow-tool', $a) }
foreach ($d in $deny)  { $toolArgs += @('--deny-tool',  $d) }

Write-Host "Ralph loop starting" -ForegroundColor Cyan
Write-Host "  Project    : $ProjectRoot"
Write-Host "  PRD        : $PrdFile"
Write-Host "  Iterations : $Iterations"
Write-Host "  Model      : $Model"
Write-Host "  Profile    : $AllowProfile"
Write-Host "  DryRun     : $DryRun"
Write-Host ""

for ($i = 1; $i -le $Iterations; $i++) {
    Write-Host "=== Iteration $i / $Iterations ===" -ForegroundColor Yellow

    # Build combined context file for this iteration
    $contextFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-ctx-{0}-{1}.md" -f $PID, $i)

    $prdContent      = Get-Content $PrdFile      -Raw
    $progressContent = Get-Content $ProgressFile -Raw
    $promptContent   = Get-Content $PromptFile   -Raw

    @"
# Ralph Iteration $i Context

## PRD ($([System.IO.Path]::GetRelativePath($ProjectRoot, $PrdFile) -replace '\\','/'))
``````json
$prdContent
``````

## Progress Log (progress.txt)
``````
$progressContent
``````

## Iteration Prompt
$promptContent
"@ | Set-Content -Path $contextFile -Encoding UTF8

    $userPrompt = "@$contextFile Follow the attached prompt."

    $copilotArgs = @(
        '--add-dir', $ProjectRoot,
        '--model',   $Model,
        '--no-color',
        '--stream',  'off',
        '--silent',
        '-p',        $userPrompt
    ) + $toolArgs

    if ($DryRun) {
        Write-Host "DRY RUN: copilot $($copilotArgs -join ' ')" -ForegroundColor DarkGray
        Remove-Item $contextFile -ErrorAction SilentlyContinue
        continue
    }

    $output = ""
    try {
        $output = & copilot @copilotArgs 2>&1 | Out-String
        Write-Host $output
    }
    catch {
        Write-Host "Iteration $i failed: $_" -ForegroundColor Red
    }
    finally {
        Remove-Item $contextFile -ErrorAction SilentlyContinue
    }

    if ($output -match '<promise>\s*COMPLETE\s*</promise>') {
        Write-Host "PRD reported COMPLETE on iteration $i. Stopping." -ForegroundColor Green
        break
    }
}

Write-Host "Ralph loop finished." -ForegroundColor Cyan
