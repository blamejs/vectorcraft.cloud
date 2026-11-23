#!/usr/bin/env bash
# Unpack a web build zip and print the folder that holds the site.
#
# Usage: scripts/unpack.sh <zip> <dest>
#
# The zip must hold at most 5,000 entries and 2 GiB uncompressed, and exactly one top-level folder
# (hidden entries count). For any other zip the script prints an empty folder instead, which
# scripts/publish.sh refuses (no index.html) and records as failed, and it writes a warning to
# stderr. A zip that cannot be read, or a <dest> that is not empty, exits 1.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || die "usage: scripts/unpack.sh <zip> <dest>"
zip=$1 dest=$2
max_entries=5000
max_bytes=2147483648

refused() {
  echo "warning: $*" >&2
  mkdir -p "$dest/refused"
  printf '%s\n' "$dest/refused"
  exit 0
}

[[ -f $zip ]] || die "$zip is missing"
if [[ -e $dest ]] && [[ -n $(ls -A "$dest") ]]; then die "$dest is not empty"; fi
listing=$(unzip -Zt "$zip") || die "$zip cannot be read"
# "<n> files, <bytes> bytes uncompressed, <bytes> bytes compressed:  <ratio>"
entries=$(printf '%s\n' "$listing" | awk '{ print $1 }')
bytes=$(printf '%s\n' "$listing" | awk '{ print $3 }')
[[ $entries =~ ^[0-9]+$ && $bytes =~ ^[0-9]+$ ]] || die "cannot read the size of $zip: $listing"
[[ $entries -le $max_entries ]] || refused "$zip has $entries entries, more than $max_entries"
[[ $bytes -le $max_bytes ]] || refused "$zip unpacks to $bytes bytes, more than $max_bytes"

mkdir -p "$dest/site"
unzip -q "$zip" -d "$dest/site" || die "$zip could not be unpacked"
shopt -s dotglob nullglob
top=("$dest"/site/*)
if [[ ${#top[@]} -eq 1 && -d ${top[0]} && ! -L ${top[0]} ]]; then
  printf '%s\n' "${top[0]}"
else
  refused "unexpected zip layout: ${top[*]##*/}"
fi
