$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression.FileSystem

$desktopRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $desktopRoot "dist"
$evidence = Join-Path $desktopRoot "smoke-evidence"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null

$script:portableProcess = $null
$script:installedProcess = $null

function Write-EvidenceJson([string]$name, $value) {
  $value | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $evidence $name) -Encoding utf8
}

function Wait-Health([int]$port, [int]$timeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -Method Get -TimeoutSec 5
      if ($health.ok -ne $true) { throw "Health endpoint did not report ok=true" }
      if ($health.profile -ne "stable") { throw "Expected profile=stable, got $($health.profile)" }
      if ($health.planning -ne "disabled") { throw "Expected planning=disabled, got $($health.planning)" }
      if (-not ($health.buildingModes -contains "markers") -or -not ($health.buildingModes -contains "shells")) {
        throw "Health endpoint did not expose both building modes"
      }
      return $health
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Timed out waiting for packaged app health on port $port. Last error: $lastError"
}

function Start-AppSmoke([string]$exe, [int]$port, [string]$label) {
  if (-not (Test-Path $exe)) { throw "$label executable missing: $exe" }
  $env:VOXEL_DESKTOP_SMOKE = "1"
  $env:VOXEL_DESKTOP_PORT = [string]$port
  $process = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { throw "$label exited before its backend became healthy (exit=$($process.ExitCode))" }
  $health = Wait-Health -port $port
  if ($process.HasExited) { throw "$label exited immediately after reporting health (exit=$($process.ExitCode))" }
  Write-Host "$label launched successfully (pid=$($process.Id), port=$port)"
  return @{ process = $process; health = $health }
}

function Stop-AppTree($process) {
  if ($null -eq $process) { return }
  try {
    if (-not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F | Out-Host
    }
  } catch {
    Write-Warning "Could not terminate smoke-test process tree: $_"
  }
}

function Generate-TinyWorld([int]$port) {
  # Small real Alton Towers bbox (~55 x 40 m). This exercises public-source
  # acquisition, stable planning-disabled generation, Bedrock serialization and
  # download without turning the packaging check into a full park generation.
  $payload = @{
    bbox = "52.98730,-1.88900,52.98780,-1.88840"
    buildings3d = $false
  } | ConvertTo-Json

  $job = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/generate" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 30
  if (-not $job.id) { throw "Generation endpoint did not return a job id" }
  Write-Host "Started packaged generation job $($job.id)"

  $deadline = (Get-Date).AddMinutes(20)
  do {
    Start-Sleep -Seconds 2
    $job = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/jobs/$($job.id)" -Method Get -TimeoutSec 15
    Write-Host "Generation: $($job.status) - $($job.progress)"
    if ($job.status -eq "failed") {
      Write-EvidenceJson "portable-generation-failed.json" $job
      throw "Packaged world generation failed: $($job.error)"
    }
  } while ($job.status -ne "complete" -and (Get-Date) -lt $deadline)

  if ($job.status -ne "complete") {
    Write-EvidenceJson "portable-generation-timeout.json" $job
    throw "Packaged world generation did not finish within 20 minutes"
  }
  if ($job.planning -ne "disabled") { throw "Generation job unexpectedly enabled planning data" }
  if ($job.buildingMode -ne "markers") { throw "Smoke generation expected 3D buildings OFF / marker mode" }
  if (-not $job.downloadUrl) { throw "Completed generation did not expose a world download" }

  $world = Join-Path $evidence "portable-smoke-world.mcworld"
  Invoke-WebRequest -Uri "http://127.0.0.1:$port$($job.downloadUrl)" -OutFile $world -TimeoutSec 120
  Validate-Mcworld $world
  Write-EvidenceJson "portable-generation.json" $job
  return @{ job = $job; world = $world }
}

function Validate-Mcworld([string]$world) {
  $file = Get-Item $world
  if ($file.Length -lt 4096) { throw "Generated .mcworld is unexpectedly small: $($file.Length) bytes" }

  $archive = [System.IO.Compression.ZipFile]::OpenRead($world)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\\', '/') })
    if (-not ($entries -contains "level.dat")) { throw "Generated .mcworld is missing level.dat" }
    if (-not ($entries | Where-Object { $_ -like "db/*" })) { throw "Generated .mcworld is missing Bedrock LevelDB entries" }
    $manifest = @{
      bytes = $file.Length
      entryCount = $entries.Count
      hasLevelDat = $true
      hasLevelDb = $true
      sampleEntries = @($entries | Select-Object -First 40)
    }
    Write-EvidenceJson "mcworld-validation.json" $manifest
  } finally {
    $archive.Dispose()
  }
  Write-Host "Validated generated Bedrock world: $($file.Name) ($([math]::Round($file.Length / 1KB, 1)) KB)"
}

function Install-And-Smoke([string]$installer) {
  $installDir = Join-Path $env:RUNNER_TEMP "voxel-mapper-installed"
  if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null

  Write-Host "Installing $([IO.Path]::GetFileName($installer)) into $installDir"
  $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "NSIS installer failed with exit code $($install.ExitCode)" }

  $installedExe = Get-ChildItem $installDir -Filter "Voxel Mapper.exe" -File -Recurse | Select-Object -First 1
  if (-not $installedExe) {
    Get-ChildItem $installDir -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-Host
    throw "Installed Voxel Mapper.exe was not found"
  }

  $started = Start-AppSmoke -exe $installedExe.FullName -port 4200 -label "Installed Voxel Mapper"
  $script:installedProcess = $started.process
  Write-EvidenceJson "installed-health.json" $started.health

  if ($started.process.HasExited) { throw "Installed Voxel Mapper did not stay running" }
  Write-Host "Installed application smoke test passed"
}

try {
  $executables = @(Get-ChildItem $dist -Filter "*.exe" -File)
  if ($executables.Count -lt 2) { throw "Expected installer and portable executables before smoke testing" }
  $installer = $executables | Where-Object { $_.Name -match "Setup" } | Select-Object -First 1
  $portable = $executables | Where-Object { $_.FullName -ne $installer.FullName } | Select-Object -First 1
  if (-not $installer) { throw "Could not identify NSIS installer (expected filename containing 'Setup')" }
  if (-not $portable) { throw "Could not identify portable executable" }

  Write-Host "Portable: $($portable.FullName)"
  Write-Host "Installer:  $($installer.FullName)"

  $started = Start-AppSmoke -exe $portable.FullName -port 4199 -label "Portable Voxel Mapper"
  $script:portableProcess = $started.process
  Write-EvidenceJson "portable-health.json" $started.health
  $generated = Generate-TinyWorld -port 4199

  Stop-AppTree $script:portableProcess
  $script:portableProcess = $null
  Start-Sleep -Seconds 2

  Install-And-Smoke -installer $installer.FullName

  Write-EvidenceJson "smoke-result.json" @{
    ok = $true
    portableExe = $portable.Name
    installerExe = $installer.Name
    portableStableHealth = $true
    planningDisabled = $true
    markerGenerationCompleted = $true
    mcworldValidated = $true
    installerLaunchCompleted = $true
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-Host "Packaged Windows end-to-end smoke test PASSED"
} finally {
  Stop-AppTree $script:portableProcess
  Stop-AppTree $script:installedProcess
  Remove-Item Env:VOXEL_DESKTOP_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:VOXEL_DESKTOP_PORT -ErrorAction SilentlyContinue
}
