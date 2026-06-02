# Run the standalone Ollama Free Coder terminal app from the current folder.
# Any remaining arguments are treated as an optional one-shot command.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File .\scripts\run-cli-windows.ps1
#   pwsh -ExecutionPolicy Bypass -File .\scripts\run-cli-windows.ps1 "Generate a new C++ solution of LeetCode problem 2222"

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Command
)

$ErrorActionPreference = 'Stop'
$CallerCwd = (Get-Location).Path
$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$Cli = Join-Path $RootDir 'out\cli.js'

if (-not (Test-Path $Cli)) {
  Push-Location $RootDir
  try { & .\node_modules\.bin\tsc.cmd -p .\ }
  finally { Pop-Location }
}

& node $Cli --cwd $CallerCwd @Command
exit $LASTEXITCODE
