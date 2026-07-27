# fetch-caldwell-overpass-fixture.ps1 — Win32 Overpass fetch for Lockhart city bbox.
param(
  [ValidateSet("lockhart-city", "county-tiled")]
  [string]$Scope = "lockhart-city",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

$lockhartBbox = @{ south = 29.83787; west = -97.72866; north = 29.9244; east = -97.62483 }
$countyBbox = @{ south = 29.62; west = -97.9; north = 30.12; east = -97.55 }

function Invoke-OverpassTile($bbox) {
  $query = "[out:json][timeout:180];(way[`"highway`"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east)););out body geom;"
  Invoke-RestMethod -Uri "https://overpass-api.de/api/interpreter" `
    -Method Post -Body $query -ContentType "text/plain" `
    -Headers @{
      "User-Agent" = "hauska-engine/1.0 (+https://cortex.empressa.io; recipe-proof-48055)"
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
  $OutFile = Join-Path $here "../src/road-intake/fixtures/caldwell-overpass-$Scope-bbox.json"
}

$byId = @{}
$t0 = Get-Date

if ($Scope -eq "lockhart-city") {
  $resp = Invoke-OverpassTile $lockhartBbox
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
  countyFips = "48055"
  displayName = "Caldwell Overpass export ($Scope)"
  scope = $Scope
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  elements = $elements
}

$payload | ConvertTo-Json -Depth 20 -Compress:$false | Set-Content -Path $OutFile -Encoding utf8
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Write-Output (@{
  event = "fetch-caldwell-overpass-fixture.done"
  scope = $Scope
  outFile = (Resolve-Path $OutFile).Path
  ways = $elements.Count
  elapsedSec = $elapsed
} | ConvertTo-Json -Compress)
