#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
Set-Location $ScriptDir

Write-Host ""
Write-Host "=== nvidia-glm-proxy uninstaller ===" -ForegroundColor Cyan
Write-Host ""

$pm2Available = Get-Command pm2 -ErrorAction SilentlyContinue

if ($pm2Available) {
    Write-Host "Stopping nvidia-glm-proxy via pm2..." -ForegroundColor Yellow
    $existing = pm2 jlist 2>$null | ConvertFrom-Json 2>$null | Where-Object { $_.name -eq "nvidia-glm-proxy" } 2>$null
    if ($existing) {
        pm2 delete nvidia-glm-proxy 2>$null
        pm2 save
        Write-Host "Proxy stopped and removed from pm2." -ForegroundColor Green
    } else {
        Write-Host "Proxy not found in pm2 (already stopped)." -ForegroundColor Yellow
    }
} else {
    Write-Host "pm2 not found. Attempting to kill any running proxy process..." -ForegroundColor Yellow
    $procs = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match "nvidia-glm-proxy"
    }
    if ($procs) {
        $procs | Stop-Process -Force
        Write-Host "Killed proxy process(es)." -ForegroundColor Green
    } else {
        Write-Host "No running proxy process found." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "The following files were NOT removed (in case you need them):" -ForegroundColor Yellow
Write-Host "  - .env (contains your API key)" -ForegroundColor White
Write-Host "  - logs/ directory" -ForegroundColor White
Write-Host ""
Write-Host "To completely remove:" -ForegroundColor White
Write-Host "  Remove-Item -Recurse -Force `"$PSScriptRoot`"" -ForegroundColor Yellow
Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
