# Launch Cloudflare Quick Tunnel forwarding to fitbit-air-mcp
$ErrorActionPreference = "Stop"

# Refresh Path so cloudflared is accessible if installed in current session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Error "cloudflared is not installed or not found in PATH."
    exit 1
}

# Verify MCP server is listening
$conn = Get-NetTCPConnection -LocalPort 8788 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if (-not $conn) {
    Write-Warning "No process is currently listening on 127.0.0.1:8788."
    Write-Warning "Please start the MCP server in another terminal using: npm start"
}

Write-Host "Starting Cloudflare Tunnel pointing to http://127.0.0.1:8788..." -ForegroundColor Cyan
Write-Host "Host header will be rewritten to 127.0.0.1:8788 (required for MCP security validation)." -ForegroundColor Cyan
Write-Host "Look for the '*.trycloudflare.com' URL below and copy your '/mcp' endpoint into ChatGPT!" -ForegroundColor Green

cloudflared tunnel --url http://127.0.0.1:8788 --http-host-header 127.0.0.1:8788 --no-autoupdate
