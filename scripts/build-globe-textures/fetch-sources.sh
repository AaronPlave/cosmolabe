#!/usr/bin/env bash
# Fetch build.py's inputs into data/source/ (gitignored, ~2.0 GB), as listed
# in sources.sha256, and verify each one. A file already present is kept only
# if its sha256 matches; a download goes to <name>.part and is renamed only
# once it matches. A mismatch stops the script: the upstream file changed (or
# the download is corrupt) and the recipes have not been checked against it.
#
# `stream:` entries (the 4-13 GB Mercury and Mars mosaics) are not
# downloaded: build.py streams and verifies them itself.
set -euo pipefail
cd "$(dirname "$0")"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

grep -v '^#' sources.sha256 | while read -r digest name origin; do
  [ -n "$digest" ] || continue
  case "$origin" in stream:*) continue ;; esac
  dest="data/source/$name"
  if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$digest" ]; then continue; fi
  mkdir -p "$(dirname "$dest")"
  tmp="$dest.part"
  echo "fetching $name"
  case "$origin" in
    git:*)
      spec="${origin#git:}"  # <commit>:<path>
      git show "$spec" > "$tmp"
      ;;
    *)
      curl -fSL --retry 3 -o "$tmp" "$origin"
      ;;
  esac
  got="$(sha256 "$tmp")"
  if [ "$got" != "$digest" ]; then
    rm -f "$tmp"
    echo "error: $name has sha256 $got, expected $digest" >&2
    exit 1
  fi
  mv "$tmp" "$dest"
done
echo "sources OK"
