# Build and install the standalone Ollama Free Coder terminal app on Windows.
#
# Usage (PowerShell 5.1+ or PowerShell 7+):
#   pwsh -ExecutionPolicy Bypass -File .\scripts\install-cli-windows.ps1
#
# Optional environment variables:
#   $env:CHAT_MODEL   = 'llama3.1:8b'
#   $env:ROUTER_MODEL = 'qwen2.5-coder:1.5b-base'
#   $env:OLLAMA_HOST  = 'http://127.0.0.1:11434'
#   $env:EXTRA_MODELS = 'qwen2.5:7b mistral:7b'
#   $env:SKIP_OLLAMA  = '1'
#   $env:SKIP_PULL    = '1'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RootDir

function Write-Log($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "xx  $m" -ForegroundColor Red; exit 1 }
function Test-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Invoke-WinGet($id) {
  if (-not (Test-Cmd winget)) { Die "winget not found. Install App Installer from Microsoft Store and re-run." }
  Write-Log "winget install --id $id"
  winget install --id $id --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Die "winget install $id failed (exit $LASTEXITCODE)." }
}

if (-not (Test-Cmd node)) {
  Write-Log 'Installing Node.js LTS via winget'
  Invoke-WinGet 'OpenJS.NodeJS.LTS'
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
}
if (-not (Test-Cmd npm)) { Die 'npm is required. Re-open PowerShell after installing Node.js, then re-run.' }
$nodeMajor = [int]((node -p 'process.versions.node.split(".")[0]').Trim())
if ($nodeMajor -lt 18) { Die "Node.js $nodeMajor detected; Ollama Free Coder CLI needs >=18." }

$OLLAMA_HOST = if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST } else { 'http://127.0.0.1:11434' }
$CHAT_MODEL = if ($env:CHAT_MODEL) { $env:CHAT_MODEL } else { 'llama3.1:8b' }
$ROUTER_MODEL = if ($env:ROUTER_MODEL) { $env:ROUTER_MODEL } else { 'qwen2.5-coder:1.5b-base' }
$EXTRA_MODELS = if ($env:EXTRA_MODELS) { $env:EXTRA_MODELS } else { '' }

function Test-OllamaUp {
  try {
    Invoke-RestMethod -Uri "$OLLAMA_HOST/api/tags" -TimeoutSec 2 | Out-Null
    return $true
  } catch { return $false }
}
function Wait-Ollama {
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-OllamaUp) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

if ($env:SKIP_OLLAMA -ne '1') {
  if (-not (Test-Cmd ollama)) {
    Write-Log 'Installing Ollama via winget'
    Invoke-WinGet 'Ollama.Ollama'
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
  }
  if (-not (Test-OllamaUp)) {
    Write-Log 'Starting Ollama in the background'
    Start-Process -WindowStyle Hidden -FilePath 'ollama' -ArgumentList 'serve'
    if (-not (Wait-Ollama)) { Die "Ollama did not start at $OLLAMA_HOST" }
  }
  if ($env:SKIP_PULL -ne '1') {
    $models = @($CHAT_MODEL, $ROUTER_MODEL) + ($EXTRA_MODELS -split '\s+' | Where-Object { $_ })
    foreach ($model in $models) {
      Write-Log "Pulling Ollama model: $model"
      $env:OLLAMA_HOST = $OLLAMA_HOST
      ollama pull $model
      if ($LASTEXITCODE -ne 0) { Die "ollama pull $model failed" }
    }
  }
}

Write-Log 'Installing npm development dependencies'
npm install
if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
Write-Log 'Compiling TypeScript'
.\node_modules\.bin\tsc.cmd -p .\
if ($LASTEXITCODE -ne 0) { Die 'TypeScript compilation failed' }
Write-Log 'Linking global commands: ofc, ollama-free-coder'
npm link --force
if ($LASTEXITCODE -ne 0) { Die 'npm link failed' }

Write-Log 'Installed. Try:'
Write-Host '  cd C:\path\to\project; ofc "Generate a new C++ solution of LeetCode problem 2222"'
Write-Host '  cd C:\path\to\project; ofc "Play Radio Tapok music"'
