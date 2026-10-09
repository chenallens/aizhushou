param([ValidateSet('start','stop','restart','status')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$AppDir = Join-Path $Root 'app\aizhushou'
$NodeExe = Join-Path $AppDir 'runtime\node.exe'
$Entry = Join-Path $AppDir 'server\index.js'
$NginxExe = Join-Path $Root 'nginx.exe'
$Logs = Join-Path $Root 'logs'
$StateFile = Join-Path $Logs 'aizhushou-process.json'

function Get-OwnedApi {
    if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
    try {
        $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.processId)"
        if ($process -and $process.ExecutablePath -eq $NodeExe -and $process.CommandLine.Contains($Entry)) { return $process }
    } catch { }
    return $null
}

function Get-OwnedNginx {
    $pidFile = Join-Path $Logs 'nginx.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int](Get-Content -LiteralPath $pidFile -Raw))"
        if ($process -and $process.ExecutablePath -eq $NginxExe) { return $process }
    } catch { }
    return $null
}

function Test-Health([string]$Url) {
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -UseBasicParsing
        return ($response.ok -eq $true -and $response.service -eq 'aizhushou')
    } catch { return $false }
}

function Stop-Managed {
    $master = Get-OwnedNginx
    if ($master) {
        Push-Location $Root
        try { & $NginxExe -s stop } finally { Pop-Location }
        Start-Sleep -Milliseconds 500
        $master = Get-OwnedNginx
        if ($master) {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($master.ProcessId)" |
                Where-Object { $_.ExecutablePath -eq $NginxExe } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $master.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    $api = Get-OwnedApi
    if ($api) { Stop-Process -Id $api.ProcessId -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force }
    Write-Host 'Stopped processes owned by this deployment folder.'
}

function Start-Managed {
    foreach ($file in @($NodeExe,$Entry,$NginxExe)) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Required file missing: $file" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.env'))) {
        throw 'Missing app\aizhushou\.env. Import or configure it before starting.'
    }
    New-Item -ItemType Directory -Path $Logs -Force | Out-Null
    if ((Get-OwnedApi) -and (Get-OwnedNginx) -and (Test-Health 'http://127.0.0.1/api/health')) {
        Write-Host 'This deployment is already running. Use restart-aizhushou.bat after configuration changes.'
        return
    }
    foreach ($port in @(80,4178)) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) {
            throw "Port $port is occupied (PID $($listeners[0].OwningProcess)). Stop the OLD deployment first; no unrelated process was stopped."
        }
    }
    Push-Location $Root
    try {
        & $NginxExe -t
        if ($LASTEXITCODE -ne 0) { throw 'Nginx configuration check failed. See logs\error.log.' }
    } finally { Pop-Location }
    $apiStarted = $false
    $nginxStarted = $false
    try {
        $process = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $Entry + '"') -WorkingDirectory $AppDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $Logs 'aizhushou-api.log') -RedirectStandardError (Join-Path $Logs 'aizhushou-api-error.log') -PassThru
        @{ processId=$process.Id; entry=$Entry; startedAt=[DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
        $apiStarted = $true
        $ready = $false
        for ($attempt=0; $attempt -lt 40; $attempt++) {
            if (Test-Health 'http://127.0.0.1:4178/api/health') { $ready=$true; break }
            if ($process.HasExited) { throw 'API exited. See logs\aizhushou-api-error.log.' }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'API did not become ready on port 4178. Check SERVER_PORT and the API logs.' }
        Start-Process -FilePath $NginxExe -ArgumentList '-c conf\nginx.conf' -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
        $nginxStarted = $true
        $ready = $false
        for ($attempt=0; $attempt -lt 20; $attempt++) {
            if ((Get-OwnedNginx) -and (Test-Health 'http://127.0.0.1/api/health')) { $ready=$true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'Nginx proxy health check failed. See logs\error.log.' }
        Write-Host 'AI assistant service started and both health checks passed.'
        Write-Host 'Server local test: http://localhost/api/health'
        Write-Host 'Portal callback: http://<server-ip>/sso/login'
        Write-Host 'No console window needs to remain open. Start again after a Windows restart.'
    } catch {
        if ($apiStarted -or $nginxStarted) { Stop-Managed }
        throw
    }
}

try {
    switch ($Action) {
        'start' { Start-Managed }
        'stop' { Stop-Managed }
        'restart' { Stop-Managed; Start-Managed }
        'status' {
            Write-Host ('Managed API running: ' + [bool](Get-OwnedApi))
            Write-Host ('Managed Nginx running: ' + [bool](Get-OwnedNginx))
            Write-Host ('Proxy health: ' + (Test-Health 'http://127.0.0.1/api/health'))
        }
    }
    exit 0
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
