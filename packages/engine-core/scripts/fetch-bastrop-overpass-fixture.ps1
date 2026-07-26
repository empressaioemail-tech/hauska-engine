# fetch-bastrop-overpass-fixture.ps1 — Win32 Overpass fetch (Node fetch TLS dead-end on some hosts).
# Writes JSON for ROAD_INTAKE_FIXTURE ingest path.
param(
  [ValidateSet("city", "county-tiled")]
  [string]$Scope = "city",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

$cityBbox = @{ south = 30.04; west = -97.38; north = 30.16; east = -97.25 }
$countyBbox = @{ south = 29.8937; west = -97.6378; north = 30.3997; east = -96.9097 }

function Invoke-OverpassTile($bbox) {
  $query = "[out:json][timeout:180];(way[`"highway`"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east)););out body geom;"
  Invoke-RestMethod -Uri "https://overpass-api.de/api/interpreter" `
    -Method Post -Body $query -ContentType "text/plain" `
    -Headers @{
      "User-Agent" = "hauska-engine/1.0 (+https://cortex.empressa.io; depth-engine R4.2)"
      "Accept" = "application/json, */*;q=0.1"
    } -TimeoutSec 300
}

function Split-Bbox($bbox, $tilesX, $tilesY) {
  $latStep = ($bbox.north - $bbox.south) / $tilesY
  $lngStep = ($bbox.east - $bbox.west) / $tilesX
  $tiles = @()
  for ($yi = 0; $yi -lt $tilesY; $yi++) {
    for ($xi = 0; $xi -lt $tilesX; $xi++) {
      $tiles += @{
        south = $bbox.south + $yi * $latStep
        west = $bbox.west + $xi * $lngStep
        north = if ($yi -eq ($tilesY - 1)) { $bbox.north } else { $bbox.south + ($yi + 1) * $latStep }
        east = if ($xi -eq ($tilesX - 1)) { $bbox.east } else { $bbox.west + ($xi + 1) * $lngStep }
      }
    }
  }
  return $tiles
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) {
  $OutFile = Join-Path $here "../src/road-intake/fixtures/bastrop-overpass-$Scope-bbox.json"
}

$byId = @{}
$t0 = Get-Date

if ($Scope -eq "city") {
  $resp = Invoke-OverpassTile $cityBbox
  foreach ($el in $resp.elements) {
    if ($el.type -eq "way" -and $el.geometry -and $el.geometry.Count -ge 2) {
      $byId[[string]$el.id] = $el
    }
  }
} else {
  $tiles = Split-Bbox $countyBbox 3 3
  foreach ($tile in $tiles) {
    $resp = Invoke-OverpassTile $tile
    foreach ($el in $resp.elements) {
      if ($el.type -eq "way" -and $el.geometry -and $el.geometry.Count -ge 2) {
        $byId[[string]$el.id] = $el
      }
    }
    Start-Sleep -Milliseconds 750
  }
}

$elements = @($byId.Values)
$payload = @{
  countyFips = "48021"
  displayName = "Bastrop Overpass export ($Scope)"
  scope = $Scope
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  elements = $elements
}

$payload | ConvertTo-Json -Depth 20 -Compress:$false | Set-Content -Path $OutFile -Encoding utf8
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Write-Output (@{
  event = "fetch-bastrop-overpass-fixture.done"
  scope = $Scope
  outFile = (Resolve-Path $OutFile).Path
  ways = $elements.Count
  elapsedSec = $elapsed
} | ConvertTo-Json -Compress)
