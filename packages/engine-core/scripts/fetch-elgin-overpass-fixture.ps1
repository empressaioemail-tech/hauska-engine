# fetch-elgin-overpass-fixture.ps1 — Win32 Overpass fetch for Elgin city bbox.
param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

# AGOL Elgin_Zoning FeatureServer/0 extent (matches ELGIN_CITY_BBOX in fetch-overpass-bbox.ts)
$elginBbox = @{
  south = 30.313790730771967
  west = -97.410938698399292
  north = 30.369229436331114
  east = -97.355026917826052
}

function Invoke-OverpassTile($bbox) {
  $query = "[out:json][timeout:180];(way[`"highway`"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east)););out body geom;"
  Invoke-RestMethod -Uri "https://overpass-api.de/api/interpreter" `
    -Method Post -Body $query -ContentType "text/plain" `
    -Headers @{
      "User-Agent" = "hauska-engine/1.0 (+https://cortex.empressa.io; elgin-roads-overpass)"
      "Accept" = "application/json, */*;q=0.1"
    } -TimeoutSec 300
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) {
  $OutFile = Join-Path $here "../src/road-intake/fixtures/elgin-overpass-elgin-city-bbox.json"
}

$byId = @{}
$t0 = Get-Date

$resp = Invoke-OverpassTile $elginBbox
foreach ($el in $resp.elements) {
  if ($el.type -eq "way" -and $el.geometry -and $el.geometry.Count -ge 2) {
    $byId[[string]$el.id] = $el
  }
}

$elements = @($byId.Values)
$payload = @{
  countyFips = "48021"
  displayName = "Elgin Overpass export (elgin-city)"
  scope = "elgin-city"
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  elements = $elements
}

$payload | ConvertTo-Json -Depth 20 -Compress:$false | Set-Content -Path $OutFile -Encoding utf8
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Write-Output (@{
  event = "fetch-elgin-overpass-fixture.done"
  scope = "elgin-city"
  outFile = (Resolve-Path $OutFile).Path
  ways = $elements.Count
  elapsedSec = $elapsed
} | ConvertTo-Json -Compress)
