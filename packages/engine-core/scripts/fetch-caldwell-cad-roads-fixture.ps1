# fetch-caldwell-cad-roads-fixture.ps1 — ArcGIS Road_Centerlines → fixture JSON.
param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$serviceUrl = "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/6"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) {
  $OutFile = Join-Path $here "../src/road-intake/fixtures/caldwell-cad-road-centerlines.json"
}

$features = @()
$offset = 0
$pageSize = 1000
$t0 = Get-Date
while ($true) {
  $url = "$serviceUrl/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&resultOffset=$offset&resultRecordCount=$pageSize&f=json"
  $resp = Invoke-RestMethod -Uri $url -TimeoutSec 120
  $page = @($resp.features)
  if ($page.Count -eq 0) { break }
  foreach ($f in $page) {
    $attrs = $f.attributes
    $path0 = $null
    if ($f.geometry -and $f.geometry.paths -and $f.geometry.paths.Count -gt 0) {
      $path0 = $f.geometry.paths[0]
    }
    if (-not $path0 -or $path0.Count -lt 2) { continue }
    $centerline = @()
    foreach ($pt in $path0) {
      $centerline += ,@([double]$pt[0], [double]$pt[1])
    }
    $features += @{
      objectId = [int]$attrs.OBJECTID
      attributes = $attrs
      centerline = $centerline
    }
  }
  if ($page.Count -lt $pageSize -and -not $resp.exceededTransferLimit) { break }
  $offset += $page.Count
}

$payload = @{
  countyFips = "48055"
  sourceUrl = $serviceUrl
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  features = $features
}
$payload | ConvertTo-Json -Depth 30 | Set-Content -Path $OutFile -Encoding utf8
Write-Output (@{
  event = "fetch-caldwell-cad-roads-fixture.done"
  outFile = (Resolve-Path $OutFile).Path
  features = $features.Count
  elapsedSec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
} | ConvertTo-Json -Compress)
