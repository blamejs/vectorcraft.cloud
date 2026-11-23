#!/usr/bin/env bash
# Check that a site serves a given build.
#
# Usage: scripts/check.sh <https-url-ending-in-/> <id>
#
# Checks that the site's root redirects to the build's path, /b/<id>/; that the page there and
# every file it preloads or loads as a script come from build <id> (the X-Build header) with the
# right types and match their integrity values; that each .wasm comes Brotli-compressed when the
# client accepts br and decodes to the same bytes as the uncompressed .wasm; and that those start
# with the wasm magic number. The whole check is repeated while any part fails, since Worker
# instances read a new build id within 30 seconds of each other. Every download and wait counts
# toward one limit of CHECK_SECONDS seconds (default 600). When the limit runs out, the script
# exits 1 if any attempt showed the build is wrong (a missing file, a wrong type, an integrity or
# Brotli mismatch), and 3 if attempts failed only on delivery (no answer, a 5xx, a timeout, or the
# root still pointing at another build). It writes verdict=good, bad or inconclusive to
# $GITHUB_OUTPUT when that is set.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
[[ $# -eq 2 && $1 == https://*/ ]] || die "usage: scripts/check.sh <https-url-ending-in-/> <id>"
url=$1 id=$2
base="${url}b/${id}/"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
deadline=$((SECONDS + ${CHECK_SECONDS:-600}))
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

header() { # <file> <name>: the value of the last such header
  tr -d '\r' <"$1" | awk -v n="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" -F': ' 'tolower($1) == n { v = $2 } END { print v }'
}

fetch() { # <url> <max-seconds> <out> [curl args...]: headers to <out>.h, body to <out>; prints the status
  local u=$1 t=$2 o=$3 left=$((deadline - SECONDS))
  shift 3
  : >"$o.h"
  if [[ $left -le 0 ]]; then echo 000; return 0; fi
  if [[ $t -gt $left ]]; then t=$left; fi
  local status
  status=$(curl -sS --max-time "$t" -D "$o.h" -o "$o" -w '%{http_code}' -H 'Cache-Control: no-cache' "$@" "$u" 2>"$work/curl.err") || status=000
  [[ $status =~ ^[1-5][0-9][0-9]$ ]] || status=000
  echo "$status"
}

# A failure is either evidence that the build is wrong (bad) or a delivery problem that may pass
# (transient: no answer, a 5xx, or a root that still points at another build). Both set $reason and
# return 1. Evidence of a wrong build is kept until an attempt passes completely.
bad() { reason=$1; definite=1; bad_reason=$1; return 1; }
transient() { reason=$1; return 1; }

# expect <what> <status> <file> <content-type prefix>: checks one file of the build.
expect() {
  local got
  # Under /b/<id>/ every path names one stored file, so a 404 that names the build (X-Build) means
  # the build lacks it; a 404 without that header came from something else.
  if [[ $2 == 404 && $(header "$3.h" X-Build) == "$id" ]]; then bad "$1 is not in build $id"; return 1; fi
  if [[ $2 != 200 ]]; then transient "$1 answered $2"; return 1; fi
  got=$(header "$3.h" X-Build)
  if [[ $got != "$id" ]]; then bad "$1 came from build '$got', not $id"; return 1; fi
  got=$(header "$3.h" Content-Type)
  if [[ $got != "$4"* ]]; then bad "$1 has type '$got'"; return 1; fi
}

type_for() { # <path>: the Content-Type prefix the Worker sends for it (TYPES in src/index.js)
  local name=${1##*/} ext=
  if [[ $name == *.* ]]; then ext=$(printf '%s' "${name##*.}" | tr '[:upper:]' '[:lower:]'); fi
  case $ext in
    js | mjs) echo text/javascript ;;
    wasm) echo application/wasm ;;
    css) echo text/css ;;
    html) echo text/html ;;
    json) echo application/json ;;
    webmanifest) echo application/manifest+json ;;
    txt | md) echo text/plain ;;
    ttf) echo font/ttf ;;
    otf) echo font/otf ;;
    woff) echo font/woff ;;
    woff2) echo font/woff2 ;;
    png) echo image/png ;;
    jpg) echo image/jpeg ;;
    svg) echo image/svg+xml ;;
    ico) echo image/x-icon ;;
    *) echo application/octet-stream ;;
  esac
}

attempt() {
  local path integrity got status location
  status=$(fetch "$url" 20 "$work/root")
  location=$(header "$work/root.h" Location)
  if [[ $status != 302 ]]; then transient "$url answered $status"; return 1; fi
  if [[ $location != "/b/$id/" && $location != "$base" ]]; then transient "$url redirects to '$location', not /b/$id/"; return 1; fi
  status=$(fetch "$base" 20 "$work/index.html")
  # The Worker redirects a build's page to / only when the build has no index.html.
  if [[ $status == 302 && $(header "$work/index.html.h" Location) == / ]]; then bad "$base redirects to /: the build has no index.html"; return 1; fi
  expect "$base" "$status" "$work/index.html" text/html || return 1
  if ! node "$here/page-assets.mjs" "$work/index.html" >"$work/assets" 2>"$work/assets.err"; then
    bad "$(cat "$work/assets.err")"
    return 1
  fi
  js= wasm=
  # The page must run a script, not only preload one (scripts/publish.sh applies the same rule).
  if ! awk -F '\t' '$3 == 1 && $1 ~ /\.m?js$/ { f = 1 } END { exit !f }' "$work/assets"; then
    bad "the page runs no .js file"
    return 1
  fi
  while IFS=$'\t' read -r path integrity _; do
    [[ -n $path ]] || continue
    expect "$path" "$(fetch "$base$path" 300 "$work/asset" -H 'Accept-Encoding: identity')" "$work/asset" "$(type_for "$path")" || return 1
    if [[ $integrity != - ]]; then
      if [[ $integrity != sha384-* ]]; then bad "$path has an integrity value this check does not read: $integrity"; return 1; fi
      if ! got="sha384-$(openssl dgst -sha384 -binary "$work/asset" | openssl base64 -A)"; then
        transient "could not compute the digest of $path"
        return 1
      fi
      if [[ $got != "$integrity" ]]; then bad "$path does not match its integrity value"; return 1; fi
    fi
    if [[ -z $js && ($path == *.js || $path == *.mjs) ]]; then js=$path; fi
    if [[ $path == *.wasm ]]; then
      if [[ -z $wasm ]]; then wasm=$path; fi
      mv "$work/asset" "$work/app.wasm"
      mv "$work/asset.h" "$work/app.wasm.h"
      wasm_check "$path" || return 1
    fi
  done <"$work/assets"
  if [[ -z $js || -z $wasm ]]; then bad "the page loads no .js or no .wasm"; return 1; fi
}

# wasm_check <path>: the identity copy in $work/app.wasm starts with the wasm magic number, and the
# Brotli copy the Worker sends decodes to the same bytes.
wasm_check() {
  local wasm=$1
  if [[ -n $(header "$work/app.wasm.h" Content-Encoding) ]]; then bad "$wasm came encoded although identity was asked for"; return 1; fi
  if [[ $(head -c 4 "$work/app.wasm" | od -An -tx1 | tr -d ' \n') != 0061736d ]]; then
    bad "$wasm does not start with the wasm magic number"
    return 1
  fi
  expect "$wasm (br)" "$(fetch "$base$wasm" 300 "$work/app.br" -H 'Accept-Encoding: br')" "$work/app.br" application/wasm || return 1
  if [[ $(header "$work/app.br.h" Content-Encoding) != br ]]; then bad "$wasm was not sent Brotli-compressed"; return 1; fi
  if ! node "$here/brotli.mjs" --check "$work/app.wasm" "$work/app.br" 2>"$work/br.err"; then
    bad "$(cat "$work/br.err")"
    return 1
  fi
}

reason=
bad_reason=
definite=0
until attempt; do
  echo "not yet: $reason" >&2
  if [[ $SECONDS -ge $((deadline - 10)) ]]; then
    if [[ $definite -eq 1 ]]; then verdict=bad code=1 reason=$bad_reason; else verdict=inconclusive code=3; fi
    if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "verdict=$verdict" >>"$GITHUB_OUTPUT"; fi
    echo "error ($verdict): $reason" >&2
    exit "$code"
  fi
  sleep 10
done
if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "verdict=good" >>"$GITHUB_OUTPUT"; fi
echo "ok: $url serves build $id at $base ($(wc -l <"$work/assets" | tr -d ' ') files the page loads, $wasm $(wc -c <"$work/app.wasm" | tr -d ' ') bytes, $(wc -c <"$work/app.br" | tr -d ' ') sent with br)"
