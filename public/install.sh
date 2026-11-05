#!/bin/bash
# User-local Sidestream CLI installer. No Homebrew, sudo, or npm install needed.
set -euo pipefail
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'This installer is for macOS.'
os=$(sw_vers -productVersion)
major=${os%%.*}
[[ $major -ge 12 ]] || fail 'The bundled tools require macOS 12 or newer.'
arch=x64
if [[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=arm64; fi

# Optional destination argument is used for isolated verification.
base=${1:-"$HOME/.local"}
root="$base/share/sidestream-cli"
mkdir -p "$root" "$base/bin"
stage=$(mktemp -d "$root/.stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
fetch() {
  /usr/bin/curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --retry 4 --retry-delay 2 --retry-connrefused --connect-timeout 20 --max-time 1800 \
    --speed-limit 1024 --speed-time 90 --progress-bar "$1" -o "$2"
}

node=$(command -v node || true)
private_node=0
if [[ -z $node ]] || ! "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 && process.arch === process.argv[1] ? 0 : 1)' "$arch" 2>/dev/null; then
  line=24
  minor=${os#*.}; minor=${minor%%.*}
  if [[ $major -lt 13 || ( $major -eq 13 && $minor -lt 5 ) ]]; then line=22; fi
  echo "Installing a private Node.js $line runtime ($arch)..."
  fetch "https://nodejs.org/dist/latest-v${line}.x/SHASUMS256.txt" "$stage/node-sums"
  read -r node_sha node_file < <(awk -v arch="$arch" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "[.]tar[.]gz$") {print $1, $2}' "$stage/node-sums")
  [[ $node_sha =~ ^[a-f0-9]{64}$ && $node_file =~ ^node-v[0-9.]+-darwin-(arm64|x64)\.tar\.gz$ ]] || fail 'Invalid Node release metadata.'
  version=${node_file#node-}; version=${version%%-darwin-*}
  fetch "https://nodejs.org/dist/$version/$node_file" "$stage/node.tar.gz"
  [[ $(/usr/bin/shasum -a 256 "$stage/node.tar.gz" | awk '{print $1}') == "$node_sha" ]] || fail 'Node checksum mismatch.'
  mkdir "$stage/node"
  /usr/bin/tar -xzf "$stage/node.tar.gz" -C "$stage/node" --strip-components=1
  node="$stage/node/bin/node"
  private_node=1
else
  node=$("$node" -p 'process.execPath')
fi
"$node" --version

echo 'Downloading the verified Sidestream CLI release (222 MB)...'
fetch 'https://downloads.sidestream.tv/cli/Sidestream-CLI-1.0.21-darwin-universal-86876e22b6c162af.tar.gz' "$stage/cli.tar.gz"
[[ $(/usr/bin/shasum -a 256 "$stage/cli.tar.gz" | awk '{print $1}') == 60a9166d1a3c53d563a9fa313952f6658a745ecb2016da4ca3c1e39e9f8b686f ]] || fail 'Sidestream checksum mismatch.'
/usr/bin/tar -xzf "$stage/cli.tar.gz" -C "$stage"
app="$stage/sidestream-cli"

echo 'Checking the CLI and every bundled runtime...'
"$node" "$app/cli/sidestream.cjs" --help >/dev/null
"$node" -e 'require(process.argv[1] + "/js/downloader.js")' "$app"
"$app/binaries/python/darwin-$arch/bin/python3" "$app/binaries/yt-dlp" --version
"$app/binaries/ffmpeg/darwin-$arch/ffmpeg" -version >/dev/null
"$app/binaries/ffmpeg/darwin-$arch/ffprobe" -version >/dev/null
"$app/binaries/deno/darwin-$arch/deno" --version
rm -f "$stage/cli.tar.gz" "$stage/node.tar.gz" "$stage/node-sums"

# Only switch the command after all downloaded tools pass their checks.
target="$root/install-${stage##*.}"
[[ ! -e $target ]] || fail 'Install destination already exists; rerun.'
mv "$stage" "$target"
if [[ $private_node -eq 1 ]]; then node="$target/node/bin/node"; fi
{
  printf '#!/bin/bash\n# Sidestream CLI launcher\nexec '
  printf '%q ' "$node" "$target/sidestream-cli/cli/sidestream.cjs"
  printf '"$@"\n'
} > "$target/launcher"
chmod 755 "$target/launcher"
"$target/launcher" --help >/dev/null
"$node" -e 'require(process.argv[1] + "/js/downloader.js")' "$target/sidestream-cli"
[[ ! -d $base/bin/sidestream ]] || fail 'The command destination is a directory.'
if [[ -e $base/bin/sidestream || -L $base/bin/sidestream ]]; then
  cp -P "$base/bin/sidestream" "$target/previous-launcher"
fi
mv -f "$target/launcher" "$base/bin/sidestream"
"$base/bin/sidestream" --version

# The optional destination argument skips shell-profile changes for testing.
if [[ $# -eq 0 ]]; then
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  bash_profile="$HOME/.bash_profile"
  for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -f $candidate ]]; then bash_profile=$candidate; break; fi
  done
  for profile in "${ZDOTDIR:-$HOME}/.zshrc" "$bash_profile"; do
    touch "$profile"
    /usr/bin/grep -Fqx "$path_line" "$profile" || printf '\n# Sidestream CLI\n%s\n' "$path_line" >> "$profile"
  done
fi
printf '\nInstalled successfully: %s/bin/sidestream\n' "$base"
printf 'Open a new Terminal tab, then run: sidestream --help\n'
