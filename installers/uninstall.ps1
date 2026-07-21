# Removes the `cmt` binary installed by install.ps1.
#
# Run from a local clone, or online without cloning:
#   irm https://raw.githubusercontent.com/FabrichJean/c-commit/main/installers/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"

$BinName = "cmt.exe"
$InstallDir = if ($env:CMT_INSTALL_DIR) { $env:CMT_INSTALL_DIR } else { "$env:LOCALAPPDATA\cmt" }
$Target = Join-Path $InstallDir $BinName

if (-not (Test-Path $Target)) {
    Write-Host "No '$BinName' installation found at $Target (nothing to do)."
    exit 0
}

Remove-Item -Force $Target
Write-Host "Removed $Target"

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -like "*$InstallDir*") {
    $NewPath = ($UserPath -split ';' | Where-Object { $_ -and $_ -ne $InstallDir }) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "Removed $InstallDir from your user PATH."
}
