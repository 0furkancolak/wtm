#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the WTM standalone binary from a GitHub Release.

.DESCRIPTION
    Downloads the wtm-windows-x64.zip archive from GitHub Releases, verifies its SHA-256 checksum
    against the release's SHA256SUMS file, and installs wtm.exe into a per-user directory that
    needs no administrator rights. This is the scripted counterpart to install.sh; see README.md's
    "Windows: experimental contributor build" section for the manual alternative and the honest
    caveat that this path has not been exercised against a real published release yet.

.PARAMETER Version
    The release tag to install (e.g. "v0.1.0-rc.1"). Defaults to resolving GitHub's latest
    release. Same as the WTM_INSTALL_VERSION environment variable; this parameter wins if both are
    set.

.PARAMETER Prefix
    Install into "<Prefix>\bin" instead of the default per-user location
    ("$env:LOCALAPPDATA\wtm"). Same as the WTM_INSTALL_PREFIX environment variable; this parameter
    wins if both are set.

.EXAMPLE
    irm https://raw.githubusercontent.com/0furkancolak/wtm/main/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -Version v1.2.3 -Prefix C:\tools\wtm

.NOTES
    Piping through `iex` (as the one-liner above does) cannot pass named parameters — PowerShell
    has nothing to bind them to. Use the environment variables (WTM_INSTALL_VERSION,
    WTM_INSTALL_PREFIX, WTM_INSTALL_BASE_URL) when installing that way; the -Version / -Prefix
    parameters only work when the script is downloaded and invoked directly.

    This script installs the executable only. It does not register the WTM daemon service; run
    `wtm daemon install` afterwards if you want the supervised background daemon.

    No tag published from this repository has ever shipped a Windows archive (only the macOS-only
    v0.1.0-rc.1 prerelease exists today), and this script has never been executed end to end — the
    sandbox that wrote it has no pwsh/powershell available. Only a structural check (the file
    exists, is non-empty, and its braces/quotes balance) has been run against it. Treat both as
    open evidence gaps until a real Windows run and a real multi-platform tag close them.
#>
[CmdletBinding()]
param(
    [Alias('v')]
    [string]$Version,

    [string]$Prefix
)

$ErrorActionPreference = 'Stop'
$ProgramName = 'wtm-install'

function Write-WtmError {
    param([string]$Message)
    Write-Error "${ProgramName}: $Message" -ErrorAction Continue
    exit 1
}

# Every network/base-URL touchpoint is overridable, so tests can point this script at a local
# fixture server instead of real GitHub.
$BaseUrl = if ($env:WTM_INSTALL_BASE_URL) { $env:WTM_INSTALL_BASE_URL } else { 'https://github.com/0furkancolak/wtm' }
$RequestedVersion = if ($Version) { $Version } elseif ($env:WTM_INSTALL_VERSION) { $env:WTM_INSTALL_VERSION } else { '' }
$InstallPrefix = if ($Prefix) { $Prefix } elseif ($env:WTM_INSTALL_PREFIX) { $env:WTM_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA 'wtm' }

# ---- platform detection --------------------------------------------------------------------
#
# WTM_INSTALL_OS / WTM_INSTALL_ARCH are an explicit, documented test-only seam (mirroring
# install.sh's own WTM_INSTALL_OS / WTM_INSTALL_ARCH), not something an end user needs to set.

$OsRaw = if ($env:WTM_INSTALL_OS) { $env:WTM_INSTALL_OS } else { 'Windows' }
$ArchRaw = if ($env:WTM_INSTALL_ARCH) { $env:WTM_INSTALL_ARCH } else { $env:PROCESSOR_ARCHITECTURE }

if ($OsRaw -ne 'Windows') {
    Write-WtmError @"
unsupported platform: os="$OsRaw" arch="$ArchRaw"

install.ps1 only supports Windows. Nothing was downloaded. On macOS or Linux use install.sh
instead; see README.md's Install section.
"@
}

$Arch = switch -Regex ($ArchRaw) {
    '^(AMD64|x64|x86_64)$' { 'x64' }
    default { '' }
}

if ($Arch -eq '') {
    Write-WtmError @"
unsupported architecture: "$ArchRaw"

install.ps1 only supports Windows x64 (wtm-windows-x64.zip is the only published Windows
archive). Nothing was downloaded. Build from source instead — see the README's Windows section.
"@
}

$ArchiveName = 'wtm-windows-x64.zip'
$ExecutableName = 'wtm.exe'

# ---- resolve the release tag -----------------------------------------------------------------

function Resolve-WtmLatestVersion {
    param([string]$LatestUrl)

    # GitHub redirects a GET on `releases/latest` to `releases/tag/<tag>`. Reading the Location
    # header off the redirect response, without following it, is simpler and more robust from
    # plain Invoke-WebRequest than authenticating against the GitHub API, and needs no token.
    $location = $null
    try {
        $response = Invoke-WebRequest -Uri $LatestUrl -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
        $location = $response.Headers['Location']
    } catch {
        $webResponse = $_.Exception.Response
        if ($null -ne $webResponse -and $webResponse.Headers -and $webResponse.Headers['Location']) {
            $location = $webResponse.Headers['Location']
        }
    }

    if (-not $location) {
        Write-WtmError "failed to resolve the latest release from $LatestUrl (no redirect Location header returned)"
    }
    if ($location -notmatch '/releases/tag/([^/?#]+)') {
        Write-WtmError "could not determine the latest release tag from redirect target: $location"
    }
    return $Matches[1]
}

$WtmVersion = if ($RequestedVersion) { $RequestedVersion } else { Resolve-WtmLatestVersion -LatestUrl "$BaseUrl/releases/latest" }
if (-not $WtmVersion) { Write-WtmError 'resolved an empty release tag' }

# ---- download and verify -----------------------------------------------------------------------

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wtm-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $DownloadBase = "$BaseUrl/releases/download/$WtmVersion"
    $ArchivePath = Join-Path $TempDir $ArchiveName
    $SumsPath = Join-Path $TempDir 'SHA256SUMS'

    Write-Host "${ProgramName}: downloading $WtmVersion $ArchiveName"
    try {
        Invoke-WebRequest -Uri "$DownloadBase/$ArchiveName" -OutFile $ArchivePath -UseBasicParsing
    } catch {
        Write-WtmError "failed to download $DownloadBase/$ArchiveName"
    }
    try {
        Invoke-WebRequest -Uri "$DownloadBase/SHA256SUMS" -OutFile $SumsPath -UseBasicParsing
    } catch {
        Write-WtmError "failed to download $DownloadBase/SHA256SUMS"
    }

    $ExpectedHash = $null
    foreach ($line in Get-Content -Path $SumsPath) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            if ($Matches[2] -eq $ArchiveName) {
                $ExpectedHash = $Matches[1].ToLowerInvariant()
                break
            }
        }
    }
    if (-not $ExpectedHash) {
        Write-WtmError "SHA256SUMS does not list $ArchiveName — refusing to install an unverified archive"
    }

    $ActualHash = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
        Write-WtmError "checksum mismatch for ${ArchiveName}: expected $ExpectedHash, got $ActualHash. The download may be corrupted or tampered with; nothing was installed"
    }

    # ---- extract and install -------------------------------------------------------------------

    $ExtractDir = Join-Path $TempDir 'extracted'
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $ExtractedExecutable = Join-Path $ExtractDir $ExecutableName
    if (-not (Test-Path -Path $ExtractedExecutable -PathType Leaf)) {
        Write-WtmError "$ArchiveName did not contain an executable named $ExecutableName"
    }

    $BinDir = Join-Path $InstallPrefix 'bin'
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $InstalledPath = Join-Path $BinDir $ExecutableName

    # Overwrites any existing wtm.exe cleanly — this is the upgrade path; no separate detection
    # needed.
    Copy-Item -Path $ExtractedExecutable -Destination $InstalledPath -Force

    # ---- report ---------------------------------------------------------------------------------

    $InstalledVersion = ''
    try {
        $VersionOutput = & $InstalledPath --version 2>$null
        if ($VersionOutput) {
            $InstalledVersion = ($VersionOutput -split "`r?`n")[0]
        }
    } catch {
        $InstalledVersion = ''
    }

    if ($InstalledVersion) {
        Write-Host "${ProgramName}: installed wtm $InstalledVersion to $InstalledPath"
    } else {
        Write-Host "${ProgramName}: installed wtm to $InstalledPath"
    }

    $PathEntries = @()
    if ($env:PATH) { $PathEntries = $env:PATH -split ';' }
    if ($PathEntries -notcontains $BinDir) {
        Write-Host "${ProgramName}: note: $BinDir is not on your PATH yet. Add it, e.g.:"
        Write-Host "  setx PATH `"`$env:PATH;$BinDir`""
        Write-Host '  (or add it to your PowerShell profile with: $env:PATH += ";' "$BinDir" '")'
    }

    Write-Host 'Next step: run "wtm doctor" to check your environment.'
} finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
