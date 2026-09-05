param([switch]$SkipBuild, [switch]$KeepRunning, [ValidateSet('local','account')][string]$LibraryMode='local', [ValidateSet('full','ranges')][string]$Suite='full')
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$appDirectory = Join-Path $repo 'bili-music-app'
$container = 'b-music-http-fixture'
if (Get-NetTCPConnection -State Listen -LocalPort 3100,8100 -ErrorAction SilentlyContinue) {
    throw 'Ports 3100/8100 must be free. This runner never stops an unknown process.'
}
if (docker ps -a --filter "name=^/$container`$" --format '{{.Names}}') { throw 'An existing fixture container must be inspected first.' }
if (-not $SkipBuild) {
    Push-Location $appDirectory
    try { npm run build; if ($LASTEXITCODE -ne 0) { throw 'App build failed' } }
    finally { Pop-Location }
}
$qaRunDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('b-music-http-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qaRunDirectory | Out-Null
$serverProcess = $null
$containerStarted = $false
try {
    docker run -d --name $container --label b-music.acceptance=true --init --shm-size 512m -p 127.0.0.1:8100:8000 --mount "type=bind,source=$repo/kernel/app,target=/app/app,readonly" -e B_MUSIC_HTTP_FIXTURE=isolated-only -e KERNEL_DATA_DIR=/tmp/b-music-http-acceptance -e LOGIN_POLL_INTERVAL_SECONDS=1 -e NETWORK_CAPTURE_MS=1000 kernel-kernel python -m uvicorn app.tests.http_fixture:app --host 0.0.0.0 --port 8000
    if ($LASTEXITCODE -ne 0) { throw 'Fixture kernel failed to start' }
    $containerStarted = $true
    $env:B_MUSIC_HTTP_FIXTURE='isolated-only'
    $env:DATABASE_PATH=Join-Path $qaRunDirectory 'app.sqlite'
    $env:KERNEL_BASE_URL='http://127.0.0.1:8100'
    $env:APP_OWNER_ID='http-fixture'
    $env:KERNEL_EXTERNAL_OWNER_ID='http-fixture'
    $env:APP_SINGLE_USER_MODE='1'
    $env:APP_LIBRARY_MODE=$LibraryMode
    $env:APP_ALLOWED_ORIGINS='capacitor://localhost'
    $env:SEARCH_PROVIDER='bilibili'
    $node=(Get-Command node).Source
    $serverProcess=Start-Process -FilePath $node -ArgumentList @('tests/mobile-api/fixture-app.mjs') -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $qaRunDirectory 'app.log') -RedirectStandardError (Join-Path $qaRunDirectory 'app-error.log')
    $deadline=(Get-Date).AddSeconds(30)
    do {
        try { $health=Invoke-RestMethod 'http://127.0.0.1:3100/api/health'; if ($health.status -eq 'ok') { break } } catch { }
        if ($serverProcess.HasExited) { throw "Fixture app exited. Logs: $qaRunDirectory" }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if (-not $health) { throw 'Fixture app startup timed out' }
    Push-Location $repo
    try { if ($Suite -eq 'ranges') { node tests/mobile-api/ranges-acceptance.mjs } else { node tests/mobile-api/acceptance.mjs }; $testExit=$LASTEXITCODE }
    finally { Pop-Location }
    Write-Output "Isolated server logs and metadata: $qaRunDirectory"
    if ($testExit -ne 0) { throw 'HTTP acceptance failed; see the generated report' }
} finally {
    if (-not $KeepRunning) {
        if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id }
        if ($containerStarted) { docker stop $container | Out-Null; docker rm $container | Out-Null }
    }
}
