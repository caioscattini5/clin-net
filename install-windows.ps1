<#
  install-windows.ps1
  Usage: run inside your project folder (example: C:\clin-net)
  - Prompts for server IP and uploads path
  - Creates .env
  - Patches server.js to use UPLOAD_DIR (backup created)
  - Downloads Poppler (pdftoppm.exe) and places it in .\bin\pdftoppm.exe
  - Optionally downloads mkcert into .\bin and optionally runs mkcert -install and mkcert <ip>
  - Runs npm ci
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Ok($m){ Write-Host $m -ForegroundColor Green }
function Write-Err($m){ Write-Host $m -ForegroundColor Red }

# ---------- prompts ----------
$projectRoot = (Get-Location).Path
Write-Host "Installer running in project folder: $projectRoot"
$serverIp = Read-Host "Enter server IP to use for certificates (example: 192.168.0.45)"
if ([string]::IsNullOrWhiteSpace($serverIp)) { Write-Err "Server IP is required. Aborting."; exit 1 }

$uploadsInput = Read-Host "Enter full path for uploads (leave blank to use project ./uploads)"
if ([string]::IsNullOrWhiteSpace($uploadsInput)) {
  $uploadsPath = Join-Path $projectRoot "uploads"
} else {
  $uploadsPath = $uploadsInput
}

# Normalize path
$uploadsPath = (Resolve-Path -LiteralPath $uploadsPath -ErrorAction SilentlyContinue) -or $uploadsPath
if ($uploadsPath -is [System.Management.Automation.PathInfo]) { $uploadsPath = $uploadsPath.Path }

Write-Host "Uploads path will be: $uploadsPath"

# ---------- create uploads dir ----------
if (-not (Test-Path $uploadsPath)) {
  New-Item -ItemType Directory -Path $uploadsPath -Force | Out-Null
  Write-Ok "Created uploads folder: $uploadsPath"
} else {
  Write-Ok "Uploads folder already exists."
}

# ---------- write .env ----------
$envPath = Join-Path $projectRoot ".env"
$envContent = @"
SERVER_IP=$serverIp
UPLOAD_DIR=$uploadsPath
PORT=3000
"@
Set-Content -Path $envPath -Value $envContent -Encoding UTF8
Write-Ok ".env written ($envPath)"

# ---------- patch server.js to use UPLOAD_DIR ----------
$serverJs = Join-Path $projectRoot "server.js"
if (-not (Test-Path $serverJs)) {
  Write-Err "server.js not found in project root ($projectRoot). Please run this script inside the project folder."
  exit 1
}

# backup
$backup = Join-Path $projectRoot "server.js.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
Copy-Item -Path $serverJs -Destination $backup -Force
Write-Ok "Backed up server.js -> $backup"

# read file
$serverText = Get-Content -Raw -Path $serverJs -Encoding UTF8

# If UPLOAD_DIR snippet already present, skip insertion
if ($serverText -notmatch "const UPLOAD_DIR\s*=") {
  $insertAfter = "const ROOT = __dirname;"
  $snippet = @"
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads');
const SERVER_IP = process.env.SERVER_IP || null;
"@
  if ($serverText -match [regex]::Escape($insertAfter)) {
    $serverText = $serverText -replace ([regex]::Escape($insertAfter)), "$insertAfter`n$snippet"
    Write-Ok "Inserted UPLOAD_DIR/SERVER_IP snippet into server.js"
  } else {
    Write-Err "Couldn't find 'const ROOT = __dirname;' to insert snippet. server.js may have different structure. Aborting patch."
    exit 1
  }
} else {
  Write-Ok "server.js already contains UPLOAD_DIR declaration. Skipping insertion."
}

# Replace occurrences: path.join(__dirname, 'uploads', ...
# We'll replace the common pattern path.join(__dirname, 'uploads', <rest>) -> path.join(UPLOAD_DIR, <rest>)
$serverText = $serverText -replace "path\.join\(\s*__dirname\s*,\s*'uploads'\s*,", "path.join(UPLOAD_DIR,"
# Also handle path.join(__dirname, 'uploads') with no further args
$serverText = $serverText -replace "path\.join\(\s*__dirname\s*,\s*'uploads'\s*\)", "UPLOAD_DIR"

# Save patched server.js
Set-Content -Path $serverJs -Value $serverText -Encoding UTF8
Write-Ok "server.js patched to use UPLOAD_DIR (backup at $backup)."

# ---------- make bin folder ----------
$binDir = Join-Path $projectRoot "bin"
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir | Out-Null; Write-Ok "Created bin folder: $binDir" }

# ---------- download Poppler (pdftoppm) ----------
# We will try to fetch the latest release from the maintained poppler-windows repo
$wantPoppler = Read-Host "Download Poppler (pdftoppm) and extract pdftoppm.exe into $binDir ? (Y/n)"
if ($wantPoppler -eq '' -or $wantPoppler -match '^[Yy]') {
  try {
    Write-Host "Querying GitHub for poppler-windows latest release..."
    $api = "https://api.github.com/repos/oschwartz10612/poppler-windows/releases/latest"
    $rel = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "cli" } -ErrorAction Stop

    # choose an asset with 'zip' in the name
    $asset = $rel.assets | Where-Object { $_.name -match '\.zip$' } | Select-Object -First 1
    if (-not $asset) { throw "No ZIP asset found in poppler-windows release." }
    $dlUrl = $asset.browser_download_url
    $zipDest = Join-Path $env:TEMP $asset.name
    Write-Host "Downloading $($asset.name) ..."
    Invoke-WebRequest -Uri $dlUrl -OutFile $zipDest -UseBasicParsing
    Write-Ok "Downloaded to $zipDest"

    # extract to temp folder
    $tmpExtract = Join-Path $env:TEMP ("poppler_extract_" + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmpExtract | Out-Null
    Expand-Archive -Path $zipDest -DestinationPath $tmpExtract -Force
    Write-Ok "Extracted poppler archive to $tmpExtract"

    # Try common locations for pdftoppm: Library\bin\pdftoppm.exe or bin\pdftoppm.exe
    $candidates = @(
      Join-Path $tmpExtract "Library\bin\pdftoppm.exe",
      Join-Path $tmpExtract "bin\pdftoppm.exe",
      (Get-ChildItem -Path $tmpExtract -Recurse -Filter "pdftoppm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    )
    $pdftoppm = $null
    foreach ($c in $candidates) {
      if ($c -and (Test-Path $c)) { $pdftoppm = $c; break }
    }
    if (-not $pdftoppm) { throw "pdftoppm.exe not found inside the extracted archive." }

    $destExe = Join-Path $binDir "pdftoppm.exe"
    Copy-Item -Path $pdftoppm -Destination $destExe -Force
    Write-Ok "Copied pdftoppm.exe -> $destExe"

    # cleanup temp
    Remove-Item -Path $zipDest -Force -ErrorAction SilentlyContinue
    # Optionally keep extracted folder for inspection; we'll remove it
    Remove-Item -Path $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Poppler installed (pdftoppm.exe available in project bin)."
  } catch {
    Write-Err "Poppler installation failed: $($_.Exception.Message)"
    Write-Host "You can manually download poppler-windows from https://github.com/oschwartz10612/poppler-windows/releases and place pdftoppm.exe into $binDir"
  }
} else {
  Write-Host "Skipping Poppler download. Ensure pdftoppm.exe is available in $binDir or on PATH."
}

# ---------- optionally download mkcert ----------
$wantMkcert = Read-Host "Download mkcert binary into project bin and optionally run mkcert -install ? (requires admin) (Y/n)"
if ($wantMkcert -eq '' -or $wantMkcert -match '^[Yy]') {
  try {
    Write-Host "Querying GitHub for mkcert latest release..."
    $api2 = "https://api.github.com/repos/FiloSottile/mkcert/releases/latest"
    $rel2 = Invoke-RestMethod -Uri $api2 -Headers @{ "User-Agent" = "cli" } -ErrorAction Stop

    # pick a windows amd64 asset (common name pattern)
    $asset2 = $rel2.assets | Where-Object { $_.name -match 'windows' -and $_.name -match 'amd64|x64|64' } | Select-Object -First 1
    if (-not $asset2) {
      # fallback: any exe
      $asset2 = $rel2.assets | Where-Object { $_.name -match '\.exe$' } | Select-Object -First 1
    }
    if (-not $asset2) { throw "mkcert windows binary not found in release assets. Please install mkcert manually." }
    $dl2 = $asset2.browser_download_url
    $mkDest = Join-Path $binDir $asset2.name
    Write-Host "Downloading mkcert -> $mkDest ..."
    Invoke-WebRequest -Uri $dl2 -OutFile $mkDest -UseBasicParsing
    # rename to mkcert.exe if needed
    $mkExe = Join-Path $binDir "mkcert.exe"
    if ($mkDest -ne $mkExe) {
      Copy-Item -Path $mkDest -Destination $mkExe -Force
      Remove-Item -Path $mkDest -Force -ErrorAction SilentlyContinue
    }
    Write-Ok "mkcert downloaded to $mkExe"
    Write-Host "Note: mkcert requires running 'mkcert -install' to add the local CA to the machine's trust store (requires admin)."

    $runMk = Read-Host "Run mkcert -install and mkcert $serverIp now? (requires admin) (Y/n)"
    if ($runMk -eq '' -or $runMk -match '^[Yy]') {
      try {
        # execute mkcert from bin
        Write-Host "Running mkcert -install (may prompt for admin)..."
        & $mkExe -install
        Write-Host "Generating certificate files for $serverIp ..."
        & $mkExe $serverIp
        Write-Ok "mkcert created cert files in project root (if mkcert ran successfully)."
      } catch {
        Write-Err "mkcert execution failed: $($_.Exception.Message)"
        Write-Host "If mkcert failed due to permissions, re-run PowerShell as Administrator and run: `.\bin\mkcert.exe -install` and `.\bin\mkcert.exe $serverIp`"
      }
    } else {
      Write-Host "Skipped running mkcert. To create certs later, run from admin PowerShell in project root: .\bin\mkcert.exe -install ; .\bin\mkcert.exe $serverIp"
    }
  } catch {
    Write-Err "mkcert download failed: $($_.Exception.Message)"
    Write-Host "Please install mkcert manually: https://github.com/FiloSottile/mkcert"
  }
} else {
  Write-Host "Skipping mkcert download."
}

# ---------- install npm packages ----------
$doNpm = Read-Host "Run 'npm ci' now to install Node dependencies? (Y/n)"
if ($doNpm -eq '' -or $doNpm -match '^[Yy]') {
  try {
    Write-Host "Running npm ci (this may take a moment)..."
    Push-Location $projectRoot
    & npm ci
    Pop-Location
    Write-Ok "npm packages installed."
  } catch {
    Write-Err "npm install failed: $($_.Exception.Message)"
    Write-Host "You can run 'npm ci' manually in the project folder."
  }
} else {
  Write-Host "Skipped npm install. Run 'npm ci' in the project folder later."
}

# ---------- final instructions ----------
Write-Ok "Install steps completed (or attempted)."
Write-Host "Summary:"
Write-Host " - Server IP: $serverIp"
Write-Host " - Uploads path: $uploadsPath"
Write-Host " - Project root: $projectRoot"
Write-Host ""
Write-Host "Next steps:"
Write-Host " 1) If you ran mkcert and it created files, ensure cert files like '$serverIp.pem' and '$serverIp-key.pem' are in project root."
Write-Host " 2) Start the server: node server.js"
Write-Host " 3) Open browser on a LAN device: https://$serverIp:3000/  (accept/allow certificate when prompted)"
Write-Host ""
Write-Host "If anything fails, check the console log printed by this script earlier for error messages."
Write-Host "If server.js patching failed or your server code is customized, you can manually edit server.js to insert:"
Write-Host "  const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads');"
Write-Host "and replace occurrences of path.join(__dirname, 'uploads', ...) with path.join(UPLOAD_DIR, ...)."
Write-Ok "Installer finished."
