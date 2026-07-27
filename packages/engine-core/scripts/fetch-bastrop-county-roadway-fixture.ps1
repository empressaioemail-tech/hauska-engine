# fetch-bastrop-county-roadway-fixture.ps1 — Win32 ArcGIS fetch (Node fetch TLS dead-end on some hosts).
# Paginates Bastrop_County_Roadway MapServer/0 and writes JSON for ROAD_INTAKE_FIXTURE ingest path.
param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

$serviceUrl = "https://maps.co.bastrop.tx.us/server/rest/services/Transportation_BP/Bastrop_County_Roadway/MapServer/0"
$pageSize = 1000
$offset = 0
$allFeatures = @()
$t0 = Get-Date

do {
  $queryUrl = "$serviceUrl/query?f=json&where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=$pageSize&resultOffset=$offset"
  $resp = Invoke-RestMethod -Uri $queryUrl -UseBasicParsing -Headers @{
    "User-Agent" = "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine S2-F)"
    "Accept" = "application/json, */*;q=0.1"
  }
  if ($resp.error) {
    throw "ArcGIS error: $($resp.error.message)"
  }
  foreach ($f in $resp.features) {
    $paths = $f.geometry.paths
    if (-not $paths -or $paths.Count -lt 1) { continue }
    $ring = $paths[0]
    if ($ring.Count -lt 2) { continue }
    $centerline = @()
    foreach ($pt in $ring) {
      $centerline += ,@([double]$pt[0], [double]$pt[1])
    }
    $allFeatures += @{
      objectId = [int]$f.attributes.objectid
      attributes = $f.attributes
      centerline = $centerline
    }
  }
  $exceeded = [bool]$resp.exceededTransferLimit
  $offset += $pageSize
} while ($exceeded)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) {
  $OutFile = Join-Path $here "../src/road-intake/fixtures/bastrop-county-roadway-full.json"
}

$payload = @{
  countyFips = "48021"
  displayName = "Bastrop County Roadway full export"
  sourceUrl = $serviceUrl
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  features = $allFeatures
}

$payload | ConvertTo-Json -Depth 20 -Compress:$false | Set-Content -Path $OutFile -Encoding utf8
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Write-Output (@{
  event = "fetch-bastrop-county-roadway-fixture.done"
  outFile = (Resolve-Path $OutFile).Path
  features = $allFeatures.Count
  elapsedSec = $elapsed
} | ConvertTo-Json -Compress)
