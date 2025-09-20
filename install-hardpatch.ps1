<#
install-hardpatch.ps1
Hard-patch server.js so uploads move to a user-provided existing absolute folder.
-- This script WILL NOT create the uploads folder; it aborts if the folder doesn't exist.
-- It backs up server.js first.
-- It replaces path.join(__dirname,'uploads'...) usages and adds app.use('/uploads', express.static(...))
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Ok($m){ Write-Host $m -ForegroundColor Green }
function Write-Warn($m){ Write-Host $m -ForegroundColor Yellow }
function Write-Err($m){ Write-Host $m -ForegroundColor Red }

$projectRoot = (Get-Location).Path
Write-Host "Project root: $projectRoot"

# sanity
$serverJs = Join-Path $projectRoot 'server.js'
if (-not (Test-Path $serverJs)) {
  Write-Err "server.js not found in project root. Run this script from the project root."
  exit 1
}

# prompts
$serverIp = Read-Host "Enter server IP (for reference / mkcert) (ex: 192.168.0.45). Leave empty to skip mkcert steps later."
$uploadsPath = Read-Host "Enter FULL path to the existing uploads base folder (MUST already exist). Example: D:\ClinicUploads"
if ([string]::IsNullOrWhiteSpace($uploadsPath)) {
  Write-Err "Uploads path required. Aborting."
  exit 1
}

# normalize and check path exists
try {
  $resolved = Resolve-Path -LiteralPath $uploadsPath -ErrorAction Stop
  $uploadsPathResolved = $resolved.Path
} catch {
  Write-Err "Provided uploads path does not exist or is not accessible: $uploadsPath"
  Write-Err "This script will NOT create the folder. Please create it first, then re-run the script."
  exit 1
}
Write-Ok "Confirmed uploads path exists: $uploadsPathResolved"

# backup server.js
$timestamp = (Get-Date).ToString("yyyyMMddHHmmss")
$backup = Join-Path $projectRoot ("server.js.bak." + $timestamp)
Copy-Item -Path $serverJs -Destination $backup -Force
Write-Ok "Backed up server.js -> $backup"

# read server.js
$serverText = Get-Content -Raw -Encoding UTF8 -Path $serverJs

# check if already patched
if ($serverText -match "UPLOAD_BASE_DIR") {
  Write-Warn "server.js already contains 'UPLOAD_BASE_DIR'. Aborting to avoid double-patch. If you want to re-patch, remove existing UPLOAD_BASE_DIR or edit server.js manually."
  exit 0
}

# prepare JS-escaped path (escape backslashes for JS string)
$escapedJsPath = $uploadsPathResolved -replace '\\','\\\\'

# Insert const UPLOAD_BASE_DIR after "const ROOT = __dirname;"
$patternRoot = "const ROOT = __dirname;"
if ($serverText -notmatch [regex]::Escape($patternRoot)) {
  Write-Err "Couldn't find the anchor line 'const ROOT = __dirname;' in server.js. The script expects this exact line to insert UPLOAD_BASE_DIR. Aborting."
  exit 1
}
$insertSnippet = "const UPLOAD_BASE_DIR = '$escapedJsPath';`n"
$serverText = $serverText -replace [regex]::Escape($patternRoot), ($patternRoot + "`n" + $insertSnippet)

Write-Ok "Inserted UPLOAD_BASE_DIR definition."

# Replace path.join(__dirname, 'uploads', ...  and the double-quote variant
$serverText = $serverText -replace "path\.join\(\s*__dirname\s*,\s*['""]uploads['""]\s*,", "path.join(UPLOAD_BASE_DIR,"
# Replace path.join(__dirname, 'uploads') with UPLOAD_BASE_DIR
$serverText = $serverText -replace "path\.join\(\s*__dirname\s*,\s*['""]uploads['""]\s*\)", "UPLOAD_BASE_DIR"

Write-Ok "Replaced path.join(__dirname,'uploads',...) occurrences."

# Ensure '/uploads' is served: insert app.use('/uploads', express.static(UPLOAD_BASE_DIR)); after the app.use(express.static(ROOT, ...)) line
# Find the first occurrence of "app.use(express.static(ROOT"
$staticPattern = "app.use(express.static(ROOT"
$pos = $serverText.IndexOf($staticPattern, [System.StringComparison]::Ordinal)
if ($pos -gt -1) {
  # find end of that line
  $rest = $serverText.Substring($pos)
  $lineEndIdx = $rest.IndexOf("`n")
  if ($lineEndIdx -lt 0) { $lineEndIdx = $rest.Length }
  $line = $rest.Substring(0, $lineEndIdx)
  $insertion = "`napp.use('/uploads', express.static(UPLOAD_BASE_DIR));"
  # insert after that line
  $replaceTarget = $line
  $serverText = $serverText -replace [regex]::Escape($replaceTarget), ($replaceTarget + $insertion)
  Write-Ok "Inserted app.use('/uploads', express.static(UPLOAD_BASE_DIR)); after express.static(ROOT ... )"
} else {
  # fallback: try to find "app.use(express.static(ROOT, {"
  if ($serverText -match "app\.use\(\s*express\.static\(\s*ROOT") {
    $serverText = $serverText -replace "app\.use\(\s*express\.static\(\s*ROOT[^\)]*\)\s*\)\s*;", "app.use(express.static(ROOT, { extensions: ['html'] }));`napp.use('/uploads', express.static(UPLOAD_BASE_DIR));"
    Write-Ok "Inserted uploads static route via fallback replacement."
  } else {
    Write-Warn "Could not find an express.static(ROOT ...) invocation to insert uploads static route automatically."
    Write-Warn "You will need to manually add: app.use('/uploads', express.static(UPLOAD_BASE_DIR)); somewhere after express.static(ROOT) in server.js."
  }
}

# Write patched server.js back
Set-Content -Path $serverJs -Value $serverText -Encoding UTF8
Write-Ok "Wrote patched server.js."

# Scan front-end files for any absolute filesystem paths or direct references to uploads folder (just informative)
$frontendFiles = @('index.html','photo-capture.html','photo-capture.js','upload-doc.html','upload-doc.js','signature.js')
$foundIssues = @()
foreach ($f in $frontendFiles) {
  $pathf = Join-Path $projectRoot $f
  if (Test-Path $pathf) {
    $txt = Get-Content -Raw -Path $pathf -Encoding UTF8
    if ($txt -match "[A-Za-z]:\\") { $foundIssues += "$f -> contains Windows absolute path-like strings" }
    if ($txt -match "/uploads/") { $foundIssues += "$f -> references '/uploads/' (this is OK - server will serve '/uploads' from the chosen base path)" }
  }
}
if ($foundIssues.Count -gt 0) {
  Write-Warn "Frontend scan found these items (informational):"
  $foundIssues | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Ok "Frontend scan OK (no absolute filesystem strings found in standard front-end files)."
}

# Optional mkcert step
if (-not [string]::IsNullOrWhiteSpace($serverIp)) {
  $doMk = Read-Host "Run mkcert -install and mkcert $serverIp now? (requires mkcert installed or script will try to download; answer Y to proceed, otherwise N)"
  if ($doMk -and $doMk -match '^[Yy]') {
    # attempt to use local bin\mkcert.exe first
    $mkLocal = Join-Path $projectRoot "bin\mkcert.exe"
    if (Test-Path $mkLocal) {
      try {
        Write-Host "Running local mkcert: $mkLocal -install"
        & $mkLocal -install
        Write-Host "Generating certs: $mkLocal $serverIp"
        & $mkLocal $serverIp
        Write-Ok "mkcert ran and (if successful) created cert files in project root."
      } catch {
        Write-Err "mkcert run failed: $($_.Exception.Message)"
        Write-Warn "If mkcert failed, you can install mkcert manually and run: mkcert -install ; mkcert $serverIp"
      }
    } else {
      Write-Warn "mkcert not found in project bin. You can install mkcert and then run mkcert -install ; mkcert $serverIp in the project root."
    }
  } else {
    Write-Host "Skipping mkcert step."
  }
}

# Run npm install
$doNpm = Read-Host "Run 'npm install' now in project root? (recommended) (Y/n)"
if ($doNpm -eq '' -or $doNpm -match '^[Yy]') {
  try {
    Push-Location $projectRoot
    npm install
    Pop-Location
    Write-Ok "npm install completed."
  } catch {
    Write-Err "npm install failed: $($_.Exception.Message)"
    Write-Host "You can run 'npm install' manually in the project folder."
  }
} else {
  Write-Host "Skipped npm install. Run 'npm install' manually later."
}

Write-Ok "Patch complete. You can now start the server: node server.js"
Write-Host "Important: server will now serve uploads from: $uploadsPathResolved (URL path = /uploads/<customerId>/<file>)"
Write-Host "If you need to restore the original server.js: copy $backup to $serverJs"
