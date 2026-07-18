# Installs the Claude Commit Planner binary as `cmt`.
#
# Run from a local clone, or online without cloning:
#   irm https://raw.githubusercontent.com/FabrichJean/ccommit/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "FabrichJean/ccommit"
$BinName = "cmt.exe"
$InstallDir = if ($env:CMT_INSTALL_DIR) { $env:CMT_INSTALL_DIR } else { "$env:LOCALAPPDATA\cmt" }
$Asset = "commit-planner-win-x64.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

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
