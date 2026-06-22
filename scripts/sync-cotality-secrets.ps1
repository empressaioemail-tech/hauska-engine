# Copy Cotality demo secrets from legacy-design-tools-prod into hauska-prod-497015.
# Idempotent: creates secret if missing, adds new version if value changed.

$ErrorActionPreference = "Continue"
$SourceProject = "legacy-design-tools-prod"
$TargetProject = "hauska-prod-497015"

if (-not $env:GOOGLE_APPLICATION_CREDENTIALS) {
  $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json"
}
$Gcloud = "C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd"

$Secrets = @(
  "COTALITY_PROPERTY_KEY",
  "COTALITY_PROPERTY_SECRET",
  "COTALITY_SPATIALTILE_KEY",
  "COTALITY_SPATIALTILE_SECRET",
  "COTALITY_RISKMETER_KEY",
  "COTALITY_RISKMETER_SECRET"
)

foreach ($name in $Secrets) {
  Write-Host "Sync $name ..."
  $val = (& $Gcloud secrets versions access latest --secret=$name --project=$SourceProject).TrimEnd()
  if (-not $val) { throw "Missing source secret $name in $SourceProject" }

  $secretExists = $false
  & $Gcloud secrets describe $name --project=$TargetProject 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $secretExists = $true }
  if (-not $secretExists) {
    & $Gcloud secrets create $name --project=$TargetProject --replication-policy=automatic | Out-Null
  }

  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($tmp, $val, $utf8NoBom)
    & $Gcloud secrets versions add $name --project=$TargetProject --data-file=$tmp | Out-Null
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  OK len=$($val.Length)"
}

Write-Host "Done. Cotality secrets synced to $TargetProject."

# Cloud Run default compute SA must read secrets at deploy/runtime.
$ProjectNumber = (& $Gcloud projects describe $TargetProject --format="value(projectNumber)").Trim()
$RunSa = "${ProjectNumber}-compute@developer.gserviceaccount.com"
Write-Host "Granting secretAccessor to $RunSa ..."
foreach ($name in $Secrets) {
  & $Gcloud secrets add-iam-policy-binding $name `
    --project=$TargetProject `
    --member="serviceAccount:$RunSa" `
    --role="roles/secretmanager.secretAccessor" 2>$null | Out-Null
}
Write-Host "IAM bindings ensured."
