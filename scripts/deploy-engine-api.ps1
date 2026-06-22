# Deploy hauska-engine-api to Cloud Run (hauska-prod-497015).
# Bakes Cotality secrets + api1 Property host. Tags revision `envelope-canary`.
#
# Prereq: run scripts/sync-cotality-secrets.ps1 once to copy secrets into this project.
#
# Usage (from hauska-engine repo root):
#   .\scripts\deploy-engine-api.ps1
#   .\scripts\deploy-engine-api.ps1 -ShiftTraffic

param(
  [switch]$ShiftTraffic
)

$ErrorActionPreference = "Stop"
$Project = "hauska-prod-497015"
$Region = "us-central1"
$Service = "hauska-engine-api"
$Image = "us-central1-docker.pkg.dev/$Project/cloud-run-source-deploy/${Service}:envelope-canary"
$Root = Split-Path $PSScriptRoot -Parent

if (-not $env:GOOGLE_APPLICATION_CREDENTIALS) {
  $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json"
}
$Gcloud = "C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd"

Push-Location $Root
try {
  Write-Host "Building image $Image ..."
  & $Gcloud builds submit --project=$Project `
    --config=scripts/cloudbuild-engine-api.yaml `
    --substitutions=_IMAGE=$Image `
    --timeout=1200s .

  $deployArgs = @(
    "run", "deploy", $Service,
    "--project=$Project",
    "--region=$Region",
    "--image=$Image",
    "--tag=envelope-canary",
    "--port=8080",
    "--timeout=300",
    "--allow-unauthenticated",
    "--set-env-vars=NODE_ENV=production,LOG_LEVEL=info,COTALITY_PROPERTY_BASE_URL=https://api1.cotality.com/v2/properties",
    "--set-secrets=COTALITY_PROPERTY_KEY=COTALITY_PROPERTY_KEY:latest,COTALITY_PROPERTY_SECRET=COTALITY_PROPERTY_SECRET:latest,COTALITY_SPATIALTILE_KEY=COTALITY_SPATIALTILE_KEY:latest,COTALITY_SPATIALTILE_SECRET=COTALITY_SPATIALTILE_SECRET:latest,COTALITY_RISKMETER_KEY=COTALITY_RISKMETER_KEY:latest,COTALITY_RISKMETER_SECRET=COTALITY_RISKMETER_SECRET:latest"
  )

  $svcExists = $false
  try {
    & $Gcloud run services describe $Service --region=$Region --project=$Project 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $svcExists = $true }
  } catch { }

  if ($svcExists) {
    $deployArgs += "--no-traffic"
  }

  & $Gcloud @deployArgs

  if ($ShiftTraffic) {
    Write-Host "Shifting 100% traffic to envelope-canary tag ..."
    & $Gcloud run services update-traffic $Service `
      --project=$Project --region=$Region --to-tags=envelope-canary=100
  }

  & $Gcloud run services describe $Service --project=$Project --region=$Region `
    --format="value(status.latestCreatedRevisionName,status.traffic)"
} finally {
  Pop-Location
}
