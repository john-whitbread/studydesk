# Builds the Studydesk installer on Windows.
#
# Run from this folder in any PowerShell window:
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
#
# It finds Visual Studio's 64-bit C++ tools itself (fixing "link.exe not
# found"), checks every prerequisite with a plain explanation, then builds.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Fail($msg) {
    Write-Host ""
    Write-Host "  X  $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}
function Ok($msg) { Write-Host "  OK $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "Studydesk build - checking prerequisites" -ForegroundColor Cyan

# 1. Node.js 20+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js isn't installed or isn't on PATH. Install the LTS version from nodejs.org, then reopen PowerShell." }
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js $(node --version) is too old. Install Node 20 or newer." }
Ok "Node.js $(node --version)"

# 2. Rust with the 64-bit MSVC toolchain
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Fail "Rust isn't installed or isn't on PATH. Install it from rustup.rs, then reopen PowerShell." }
$host_triple = (rustc -vV | Select-String '^host:').ToString().Split(' ')[1]
if ($host_triple -ne "x86_64-pc-windows-msvc") {
    Write-Host "     Rust host is $host_triple; switching the default to stable-x86_64-pc-windows-msvc..."
    rustup default stable-x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't switch Rust to the MSVC toolchain. Run: rustup default stable-x86_64-pc-windows-msvc" }
}
Ok "Rust $(rustc --version) ($((rustc -vV | Select-String '^host:').ToString().Split(' ')[1]))"

# 3. Visual Studio C++ x64 tools (this is what provides link.exe)
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { Fail "Visual Studio Installer wasn't found. Install 'Build Tools for Visual Studio' with 'Desktop development with C++'." }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) {
    Fail ("The 64-bit C++ build tools aren't installed.`n" +
          "     Open 'Visual Studio Installer' > Modify (Build Tools 2022 or Visual Studio) >`n" +
          "     tick 'Desktop development with C++' (includes MSVC x64/x86 build tools and the Windows 11 SDK) > Install.")
}
$devShell = Join-Path $vs "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
if (-not (Test-Path $devShell)) { Fail "Found Visual Studio at $vs but its developer shell module is missing. Repair it in Visual Studio Installer." }
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null
Set-Location -Path $PSScriptRoot
$link = (Get-Command link.exe -ErrorAction SilentlyContinue).Source
if (-not $link -or $link -notmatch 'x64') { Fail "Visual Studio is installed, but the 64-bit linker still isn't available. Repair 'Desktop development with C++' in Visual Studio Installer." }
Ok "C++ x64 tools: $vs"
Ok "Linker: $link"

# 3b. Windows SDK (provides kernel32.lib etc.; without it every link fails with LNK1181)
$sdkLib = $null
foreach ($dir in ($env:LIB -split ';')) {
    if ($dir -and (Test-Path (Join-Path $dir "kernel32.lib"))) { $sdkLib = $dir; break }
}
if (-not $sdkLib) {
    Fail ("The Windows SDK isn't installed (kernel32.lib not found), so nothing can be linked.`n" +
          "     Open 'Visual Studio Installer' > Modify (Build Tools 2022) > 'Individual components' tab >`n" +
          "     search 'Windows 11 SDK' > tick the newest one > Modify. Then run this script again.")
}
Ok "Windows SDK: $sdkLib"

# 4. WebView2 (built into Windows 11; the installer also bootstraps it if missing)
$wv = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($wv) { Ok "WebView2 $($wv.pv)" } else { Write-Host "  !  WebView2 not detected; the installer will download it if needed." -ForegroundColor Yellow }

Write-Host ""
Write-Host "Installing dependencies (exact locked versions)..." -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (see above)." }

Write-Host ""
Write-Host "Building Studydesk (the first build takes several minutes)..." -ForegroundColor Cyan
npm run tauri build
if ($LASTEXITCODE -ne 0) { Fail "The build failed. Copy everything above this line and paste it into your chat with Claude." }

$installer = Get-ChildItem -Path "src-tauri\target\release\bundle\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
if ($installer) {
    Ok "Done. Installer: $($installer.FullName)"
    Write-Host "     Opening the folder..."
    Start-Process explorer.exe -ArgumentList "/select,`"$($installer.FullName)`""
} else {
    Ok "Done. The app is at src-tauri\target\release\studydesk.exe"
}
