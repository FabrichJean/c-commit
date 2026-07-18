# Installs the Claude Commit Planner binary as `cmt`.
#
# Run from a local clone, or online without cloning:
#   irm https://raw.githubusercontent.com/FabrichJean/c-commit/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
# Piped execution (irm | iex) can inherit $ProgressPreference = 'SilentlyContinue', which hides
# Invoke-WebRequest's built-in download progress bar - force it on so downloads aren't silent.
$ProgressPreference = "Continue"

$Repo = "FabrichJean/c-commit"
$BinName = "cmt.exe"
$InstallDir = if ($env:CMT_INSTALL_DIR) { $env:CMT_INSTALL_DIR } else { "$env:LOCALAPPDATA\cmt" }
$Asset = "commit-planner-win-x64.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$ExistingBinary = Join-Path $InstallDir $BinName
if (Test-Path $ExistingBinary) {
    Write-Host "'$BinName' is already installed at $ExistingBinary."
    Write-Host "Continuing will overwrite it with the latest version."
    Write-Host "To remove it instead, run:"
    Write-Host "  irm https://raw.githubusercontent.com/$Repo/main/uninstall.ps1 | iex"
    Write-Host ""
    $Reply = Read-Host "Continue and reinstall/upgrade '$BinName'? [y/N]"
    if ($Reply -notmatch '^[yY]') {
        Write-Host "Aborted - existing installation left untouched."
        exit 0
    }
    Write-Host ""
}

# Local clone (real script file with a sibling package.json) vs. piped via `irm | iex`
# (no real file path) - decides whether to build locally or fetch a GitHub release.
$RepoRoot = $null
if ($PSCommandPath) {
    $CandidateRoot = Split-Path -Parent $PSCommandPath
    if (Test-Path (Join-Path $CandidateRoot "package.json")) {
        $RepoRoot = $CandidateRoot
    }
}

if ($RepoRoot) {
    $BinaryPath = Join-Path $RepoRoot "dist\bin\$Asset"

    if (-not (Test-Path $BinaryPath)) {
        Write-Host "[1/2] Compiled binary not found at $BinaryPath"
        Write-Host "Building it now via 'npm run compile'..."
        Push-Location $RepoRoot
        npm run compile
        Pop-Location
    }

    if (-not (Test-Path $BinaryPath)) {
        Write-Error "Build did not produce $BinaryPath - aborting."
        exit 1
    }

    Write-Host "[2/2] Installing..."
    Copy-Item -Force $BinaryPath (Join-Path $InstallDir $BinName)
} else {
    # Release assets are zip-compressed (the embedded Node.js runtime dominates the raw binary
    # size, and zip shrinks that noticeably) - extract after downloading.
    $ZipAsset = "$Asset.zip"
    $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$ZipAsset"
    Write-Host "[1/3] Downloading $ZipAsset from the latest release of $Repo..."

    $TempZip = Join-Path ([System.IO.Path]::GetTempPath()) "$([guid]::NewGuid()).zip"
    $TempExtractDir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
    try {
        # -Verbose:$false keeps Invoke-WebRequest's own status lines out of the way while still
        # showing its native progress bar (percent, speed, ETA) since $ProgressPreference is on.
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -Verbose:$false
        Write-Host "[2/3] Extracting..."
        Expand-Archive -Path $TempZip -DestinationPath $TempExtractDir -Force
        Write-Host "[3/3] Installing..."
        Copy-Item -Force (Join-Path $TempExtractDir $Asset) (Join-Path $InstallDir $BinName)
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $TempZip
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $TempExtractDir
    }
}

Write-Host "Installed '$BinName' -> $InstallDir\$BinName"

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your user PATH. Restart your terminal for it to take effect, then run 'cmt'."
} else {
    Write-Host "You're all set - run 'cmt' from anywhere."
}
