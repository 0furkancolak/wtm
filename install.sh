#!/bin/sh
# wtm install script (POSIX sh — macOS and Linux)
#
# Downloads a released WTM standalone-binary archive from GitHub Releases, verifies its SHA-256
# checksum against the release's SHA256SUMS file, and installs the `wtm` executable into a
# user-owned prefix. This is the scripted version of the manual curl+shasum steps documented in
# README.md's "macOS: published prerelease binary" section; both routes exist side by side.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/0furkancolak/wtm/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/0furkancolak/wtm/main/install.sh | sh -s -- --version v1.2.3
#   sh install.sh --prefix /usr/local
#
# Options:
#   --version, -v <tag>   Install this release tag instead of resolving GitHub's latest release.
#   --prefix <dir>        Install into <dir>/bin instead of the default prefix.
#   -h, --help            Print this help text and exit.
#
# Environment overrides (every network/base-URL touchpoint is overridable, for testing against a
# local fixture server instead of real GitHub):
#   WTM_INSTALL_VERSION     Same as --version. The --version flag wins if both are given.
#   WTM_INSTALL_PREFIX      Same as --prefix. Default: $HOME/.local (installs to $HOME/.local/bin),
#                            mirroring the Makefile's PREFIX/BINDIR convention.
#   WTM_INSTALL_BASE_URL    Base URL releases are served from. Default:
#                            https://github.com/0furkancolak/wtm
#   WTM_INSTALL_OS          Test-only seam: overrides the `uname -s` value platform detection reads.
#   WTM_INSTALL_ARCH        Test-only seam: overrides the `uname -m` value platform detection reads.
#
# This script does not register the daemon. `make install` (building from source) remains the
# route that also does that; this script's scope is the binary alone, so it is safe to use to
# upgrade an existing from-source install's executable in place.
#
# No tag published from this repository has ever shipped a Linux or Windows archive: only the
# macOS-only v0.1.0-rc.1 prerelease exists today. This script's Linux path is therefore untested
# against a real release until a future tag carries a Linux archive — see docs/12 and the README
# for the same caveat stated about every other still-unverified distribution channel.

set -eu

program_name='wtm-install'

die() {
  printf '%s: %s\n' "$program_name" "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version <tag>] [--prefix <dir>]

  --version, -v <tag>   Install this release tag (default: GitHub's latest release)
  --prefix <dir>        Install into <dir>/bin (default: $HOME/.local, i.e. $HOME/.local/bin)
  -h, --help            Print this help text and exit

Environment overrides: WTM_INSTALL_VERSION, WTM_INSTALL_PREFIX, WTM_INSTALL_BASE_URL
(WTM_INSTALL_OS / WTM_INSTALL_ARCH are test-only detection seams, not meant for normal use.)
EOF
}

# ---- argument parsing -------------------------------------------------------------------------

cli_version=''
cli_prefix=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|-v)
      [ "$#" -ge 2 ] || die "$1 requires an argument"
      cli_version="$2"
      shift 2
      ;;
    --version=*)
      cli_version="${1#--version=}"
      shift
      ;;
    --prefix)
      [ "$#" -ge 2 ] || die "$1 requires an argument"
      cli_prefix="$2"
      shift 2
      ;;
    --prefix=*)
      cli_prefix="${1#--prefix=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unrecognized argument: $1"
      ;;
  esac
done

base_url="${WTM_INSTALL_BASE_URL:-https://github.com/0furkancolak/wtm}"
requested_version="${cli_version:-${WTM_INSTALL_VERSION:-}}"
prefix="${cli_prefix:-${WTM_INSTALL_PREFIX:-${HOME}/.local}}"

command -v curl >/dev/null 2>&1 || die 'curl is required and was not found on PATH'
command -v tar >/dev/null 2>&1 || die 'tar is required and was not found on PATH'

# ---- platform detection -----------------------------------------------------------------------
#
# WTM_INSTALL_OS / WTM_INSTALL_ARCH stand in for `uname -s` / `uname -m` respectively; this is an
# explicit, documented test seam (see scripts/__tests__/install-script.test.ts), not something an
# end user needs to set.

os_raw="${WTM_INSTALL_OS:-$(uname -s)}"
arch_raw="${WTM_INSTALL_ARCH:-$(uname -m)}"

case "$os_raw" in
  Darwin) os='darwin' ;;
  Linux) os='linux' ;;
  *) os='' ;;
esac

case "$arch_raw" in
  arm64|aarch64) arch='arm64' ;;
  x86_64|amd64) arch='x64' ;;
  *) arch='' ;;
esac

archive=''
if [ -n "$os" ] && [ -n "$arch" ]; then
  case "${os}/${arch}" in
    darwin/arm64) archive='wtm-darwin-arm64.tar.gz' ;;
    darwin/x64) archive='wtm-darwin-x64.tar.gz' ;;
    linux/x64) archive='wtm-linux-x64.tar.gz' ;;
    linux/arm64) archive='wtm-linux-arm64.tar.gz' ;;
  esac
fi

if [ -z "$archive" ]; then
  cat >&2 <<EOF
$program_name: unsupported platform: uname -s reported "$os_raw", uname -m reported "$arch_raw"

install.sh supports:
  macOS  (Darwin) arm64 or x86_64
  Linux  (Linux)  x86_64 or arm64/aarch64

Nothing was downloaded. Build from source instead — see the README's "macOS and Linux: from
source" section — or, on Windows, use install.ps1.
EOF
  exit 1
fi

executable_name='wtm'

# ---- resolve the release tag ------------------------------------------------------------------

resolve_latest_version() {
  # GitHub redirects a GET on `releases/latest` to `releases/tag/<tag>`; following redirects and
  # reading back the URL curl actually landed on is simpler and more robust from plain curl than
  # authenticating against the GitHub API, and needs no token.
  final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "${base_url}/releases/latest")" \
    || die "failed to resolve the latest release from ${base_url}/releases/latest"
  case "$final_url" in
    */releases/tag/*)
      printf '%s' "${final_url##*/releases/tag/}"
      ;;
    *)
      die "could not determine the latest release tag from redirect target: $final_url"
      ;;
  esac
}

if [ -n "$requested_version" ]; then
  version="$requested_version"
else
  version="$(resolve_latest_version)"
fi

[ -n "$version" ] || die 'resolved an empty release tag'

# ---- download and verify ----------------------------------------------------------------------

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/wtm-install.XXXXXX")" || die 'failed to create a temporary directory'
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT INT TERM HUP

download_base="${base_url}/releases/download/${version}"

printf '%s: downloading %s %s\n' "$program_name" "$version" "$archive"
curl -fsSL -o "${tmpdir}/${archive}" "${download_base}/${archive}" \
  || die "failed to download ${download_base}/${archive}"
curl -fsSL -o "${tmpdir}/SHA256SUMS" "${download_base}/SHA256SUMS" \
  || die "failed to download ${download_base}/SHA256SUMS"

checksum_ok=1
if command -v shasum >/dev/null 2>&1; then
  ( cd "$tmpdir" && shasum -a 256 -c --ignore-missing SHA256SUMS ) || checksum_ok=0
elif command -v sha256sum >/dev/null 2>&1; then
  ( cd "$tmpdir" && sha256sum -c --ignore-missing SHA256SUMS ) || checksum_ok=0
else
  die 'neither shasum nor sha256sum is available to verify the download'
fi

if [ "$checksum_ok" -ne 1 ]; then
  die "checksum verification failed for ${archive} — the download may be corrupted or tampered with; nothing was installed"
fi

# ---- extract and install -----------------------------------------------------------------------

extract_dir="${tmpdir}/extracted"
mkdir -p "$extract_dir"
tar -xzf "${tmpdir}/${archive}" -C "$extract_dir" \
  || die "failed to extract ${archive}"
[ -f "${extract_dir}/${executable_name}" ] || die "${archive} did not contain an executable named ${executable_name}"

bindir="${prefix}/bin"
mkdir -p "$bindir" || die "failed to create install directory ${bindir}"
installed_path="${bindir}/${executable_name}"

# Overwrites any existing wtm cleanly — this is the upgrade path; no separate detection needed.
if command -v install >/dev/null 2>&1; then
  install -m 0755 "${extract_dir}/${executable_name}" "$installed_path"
else
  cp "${extract_dir}/${executable_name}" "$installed_path"
  chmod 0755 "$installed_path"
fi

# ---- report -------------------------------------------------------------------------------------

installed_version=''
if installed_version_output="$("$installed_path" --version 2>/dev/null)"; then
  installed_version="$(printf '%s\n' "$installed_version_output" | head -n 1)"
fi

if [ -n "$installed_version" ]; then
  printf '%s: installed wtm %s to %s\n' "$program_name" "$installed_version" "$installed_path"
else
  printf '%s: installed wtm to %s\n' "$program_name" "$installed_path"
fi

case ":${PATH}:" in
  *":${bindir}:"*) ;;
  *) printf '%s: note: %s is not on your PATH yet. Add it, e.g. in your shell profile:\n  export PATH="%s:$PATH"\n' "$program_name" "$bindir" "$bindir" ;;
esac

printf 'Next step: run `wtm doctor` to check your environment.\n'
