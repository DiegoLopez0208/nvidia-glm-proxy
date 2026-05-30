#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
Set-Location $ScriptDir

function Write-Step($msg) {
    Write-Host ""
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Test-Command($name) {
    Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
}

Write-Host ""
Write-Host "  nvidia-glm-proxy installer for Windows" -ForegroundColor Yellow
Write-Host ""

# 1. Check Node.js
Write-Step "1/6 Checking Node.js"
if (-not (Test-Command node)) {
    Write-Host "ERROR: Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Download from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}
$nodeVer = node --version
Write-Host "Node.js $nodeVer found." -ForegroundColor Green

# 2. Check .env
Write-Step "2/6 Checking .env configuration"
$envFile = Join-Path $ScriptDir ".env"
$envExample = Join-Path $ScriptDir ".env.example"
if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "Created .env from .env.example" -ForegroundColor Yellow
        Write-Host "IMPORTANT: Edit $envFile and set your NVIDIA_API_KEY" -ForegroundColor Red
        Write-Host ""
        Read-Host "Press Enter after editing .env, or Ctrl+C to abort"
    } else {
        @"
NVIDIA_API_KEY=nvapi-your-key-here
NVIDIA_NIM_HOST=integrate.api.nvidia.com
NVIDIA_NIM_PORT=443
PROXY_PORT=9999
UPSTREAM_TIMEOUT=180000
BIND_ADDRESS=127.0.0.1
VISION_MODEL=meta/llama-3.2-90b-vision-instruct
"@ | Set-Content $envFile -Encoding UTF8
        Write-Host "Created .env with defaults." -ForegroundColor Yellow
        Write-Host "IMPORTANT: Edit $envFile and set your NVIDIA_API_KEY" -ForegroundColor Red
        Read-Host "Press Enter after editing .env, or Ctrl+C to abort"
    }
} else {
    Write-Host ".env already exists." -ForegroundColor Green
}

# Verify API key is set
$envContent = Get-Content $envFile -Raw
if ($envContent -match "NVIDIA_API_KEY=\s*$" -or $envContent -match "NVIDIA_API_KEY=nvapi-your-key-here") {
    Write-Host "WARNING: NVIDIA_API_KEY is not configured in .env!" -ForegroundColor Red
    Write-Host "Edit $envFile and set your key before continuing." -ForegroundColor Yellow
    Read-Host "Press Enter after editing, or Ctrl+C to abort"
}

# 3. Install pm2
Write-Step "3/6 Installing pm2"
if (-not (Test-Command pm2)) {
    Write-Host "Installing pm2 globally..." -ForegroundColor Yellow
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install pm2" -ForegroundColor Red
        exit 1
    }
    Write-Host "pm2 installed." -ForegroundColor Green
} else {
    Write-Host "pm2 already installed." -ForegroundColor Green
}

# 4. Create logs directory
Write-Step "4/6 Setting up logs directory"
$logsDir = Join-Path $ScriptDir "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
    Write-Host "Created logs directory." -ForegroundColor Green
} else {
    Write-Host "logs directory exists." -ForegroundColor Green
}

# 5. Start proxy with pm2
Write-Step "5/6 Starting nvidia-glm-proxy with pm2"
Push-Location $ScriptDir
$existing = pm2 jlist 2>$null | ConvertFrom-Json 2>$null | Where-Object { $_.name -eq "nvidia-glm-proxy" } 2>$null
if ($existing) {
    pm2 delete nvidia-glm-proxy 2>$null
}
pm2 start ecosystem.config.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to start proxy with pm2" -ForegroundColor Red
    Pop-Location
    exit 1
}
pm2 save
Pop-Location

Start-Sleep -Seconds 2

# 6. Verify
Write-Step "6/6 Verifying proxy is running"
$proxyPort = $null
if ($envContent -match "PROXY_PORT=(\d+)") {
    $proxyPort = $Matches[1]
} else {
    $proxyPort = "9999"
}

try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$proxyPort/health" -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
        Write-Host ""
        Write-Host "SUCCESS: nvidia-glm-proxy is running at http://127.0.0.1:$proxyPort" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next step: update your client config (e.g. opencode, claude):" -ForegroundColor Yellow
        Write-Host '  Change: "baseURL": "https://integrate.api.nvidia.com/v1"' -ForegroundColor White
        Write-Host "  To:     `"baseURL`": `"http://127.0.0.1:$proxyPort/v1`"" -ForegroundColor White
    }
} catch {
    Write-Host ""
    Write-Host "WARNING: Proxy started but health check failed." -ForegroundColor Yellow
    Write-Host "Check logs with: pm2 logs nvidia-glm-proxy" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Optional: Install as Windows Service ===" -ForegroundColor Cyan
Write-Host "To run nvidia-glm-proxy as a Windows Service (starts on boot):" -ForegroundColor White
Write-Host "  1. Run: npm install -g pm2-windows-service" -ForegroundColor White
Write-Host "  2. Run: pm2-service-install" -ForegroundColor White
Write-Host "  3. The service will auto-start pm2 on boot, which starts the proxy" -ForegroundColor White
Write-Host ""
Write-Host "Useful pm2 commands:" -ForegroundColor Yellow
Write-Host "  pm2 status                - list running processes" -ForegroundColor White
Write-Host "  pm2 logs nvidia-glm-proxy - view logs" -ForegroundColor White
Write-Host "  pm2 restart nvidia-glm-proxy - restart proxy" -ForegroundColor White
Write-Host "  pm2 stop nvidia-glm-proxy    - stop proxy" -ForegroundColor White
