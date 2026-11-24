#!/usr/bin/env bash
# Install the pinned MCP servers (TASK-040 MCP-07, G040-13). Usage: scripts/mcp-install.sh [github|clickup|google|hostinger ...]
# The sha256/integrity committed in mcp/<svc>/server.toml is the anchor: a mismatch aborts, even if a downloaded
# checksums file agrees. No npx, no uvx, no @latest. Nothing is installed globally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
die() { echo "mcp-install: $*" >&2; exit 1; }

"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "need Python >= 3.11 (set PYTHON=...)"

toml() {  # toml <file> <dotted.key>
  "$PY" -I -c 'import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
for k in sys.argv[2].split("."):
    d = d[k]
print(d)' "$1" "$2"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_github() {
  local dir="$ROOT/mcp/github" cfg="$ROOT/mcp/github/server.toml" os arch key ver anchor bin_anchor asset base tmp actual listed
  case "$(uname -s)" in Darwin) os=Darwin ;; Linux) os=Linux ;; *) die "unsupported OS" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x86_64 ;; *) die "unsupported arch" ;; esac
  key="$(echo "${os}_${arch}" | tr '[:upper:]' '[:lower:]')"
  ver="$(toml "$cfg" pin.version)"
  anchor="$(toml "$cfg" "pin.sha256.$key")"
  [[ "$anchor" =~ ^[0-9a-f]{64}$ ]] || die "bad anchor hash in server.toml"
  asset="github-mcp-server_${os}_${arch}.tar.gz"
  base="https://github.com/github/github-mcp-server/releases/download/v${ver}"
  mkdir -p "$dir"
  tmp="$(mktemp -d "$dir/.dl.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/$asset" "$base/$asset"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/checksums.txt" "$base/github-mcp-server_${ver}_checksums.txt"
  actual="$(sha256_of "$tmp/$asset")"
  [ "$actual" = "$anchor" ] || die "sha256 mismatch against server.toml for $asset"
  listed="$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")"
  [ "$listed" = "$actual" ] || die "sha256 mismatch against the release checksums file for $asset"
  if command -v gh >/dev/null 2>&1; then
    gh attestation verify "$tmp/$asset" --repo github/github-mcp-server || die "attestation verify failed"
  else
    echo "mcp-install: gh not found, attestation NOT verified (Gate 2 must do it)" >&2
  fi
  tar -tzf "$tmp/$asset" | grep -Fxq github-mcp-server || die "binary member not found in archive"
  tar -xzf "$tmp/$asset" -C "$tmp" github-mcp-server
  # the host re-hashes the binary at every start against pin.binary_sha256 (G040-13, G2T040-02); check before install
  actual="$(sha256_of "$tmp/github-mcp-server")"
  bin_anchor="$(toml "$cfg" "pin.binary_sha256.$key")"
  if [[ "$bin_anchor" =~ ^[0-9a-f]{64}$ ]]; then
    [ "$actual" = "$bin_anchor" ] || die "binary sha256 mismatch against server.toml"
  else
    echo "mcp-install: binary_sha256 for $key is PENDING; verify out of band, then set it in server.toml: $actual" >&2
  fi
  mkdir -p "$dir/bin"
  install -m 0755 "$tmp/github-mcp-server" "$dir/bin/github-mcp-server"
  echo "github: installed v$ver ($key)"
}

install_node() {  # install_node <svc> <package path under node_modules>
  local svc="$1" pkg="$2" dir="$ROOT/mcp/$1"
  [ -f "$dir/package-lock.json" ] || die "$svc: package-lock.json missing"
  (cd "$dir" && "$PY" -I -c 'import json, sys, tomllib
lock = json.load(open("package-lock.json")); pin = tomllib.load(open("server.toml", "rb"))["pin"]
pk = lock["packages"]
assert lock["lockfileVersion"] >= 3, "lockfile v3 required"
assert all("integrity" in v for k, v in pk.items() if k and not v.get("link")), "package without integrity"
top = pk[sys.argv[1]]
assert top["version"] == pin["version"] and top["integrity"] == pin["integrity"], "lock does not match server.toml pin"' "node_modules/$pkg") || die "$svc: lock check failed"
  (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund)
  echo "$svc: installed"
}

install_google() {
  local dir="$ROOT/mcp/google" ver
  [ -f "$dir/requirements.lock" ] || die "google: requirements.lock missing"
  ver="$(toml "$dir/server.toml" pin.version)"
  grep -Fxq "workspace-mcp==$ver \\" "$dir/requirements.lock" || die "google: lock does not pin workspace-mcp==$ver"
  "$PY" -m venv "$dir/.venv"
  "$dir/.venv/bin/pip" install --require-hashes --only-binary=:all: --no-deps -r "$dir/requirements.lock"
  echo "google: installed"
}

[ "$#" -gt 0 ] || set -- github clickup google hostinger
for svc in "$@"; do
  case "$svc" in
    github) install_github ;;
    clickup) install_node clickup "@hauptsache.net/clickup-mcp" ;;
    google) install_google ;;
    hostinger) install_node hostinger "@hostinger/mcp" ;;
    *) die "unknown service: $svc" ;;
  esac
done
