# Installs the Claude Commit Planner binary as `cmt`.
#
# Run from a local clone, or online without cloning:
#   irm https://raw.githubusercontent.com/FabrichJean/c-commit/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

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
        Write-Host "Compiled binary not found at $BinaryPath"
        Write-Host "Building it now via 'npm run compile'..."
        Push-Location $RepoRoot
        npm run compile
        Pop-Location
    }

    if (-not (Test-Path $BinaryPath)) {
        Write-Error "Build did not produce $BinaryPath - aborting."
        exit 1
    }

    Copy-Item -Force $BinaryPath (Join-Path $InstallDir $BinName)
} else {
    $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$Asset"
    Write-Host "Downloading $Asset from the latest release of $Repo..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile (Join-Path $InstallDir $BinName)
}

Write-Host "Installed '$BinName' -> $InstallDir\$BinName"

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your user PATH. Restart your terminal for it to take effect, then run 'cmt'."
} else {
    Write-Host "You're all set - run 'cmt' from anywhere."
}
