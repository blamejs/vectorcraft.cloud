#!/usr/bin/env bash
# Upload one web build to an R2 bucket and make it the build the Worker serves.
#
# Usage: scripts/publish.sh <bucket> <label> <site-dir>
#
# The build gets the id <label>.<UTC time>, so every upload goes to a new builds/<id>/ folder and
# never changes files that are being served. The id is added to HISTORY first, and
# builds/<id>/MANIFEST, which lists every key of the build, is uploaded before the files, so
# scripts/cleanup.sh can also delete a build whose upload stopped part way. Each .wasm file is also uploaded as a Brotli .wasm.br.
# Last, STATE is written in one step with current set to the new id and previous to the old
# current; checked keeps naming the last build that passed its check, until scripts/mark-checked.sh
# records the new one. Files and folders whose names start with "." or "_" are not uploaded (the
# Worker does not serve them). A top-level file named MANIFEST, any .wasm.br file, a symbolic link
# and a file name with characters other than letters, digits, ".", "_", "-" and "/" are refused.
# The last line of output is `id=<id>`, and the id is also written to $GITHUB_OUTPUT, when that is
# set, just before STATE.
#
# The script exits 2 when the site itself cannot be published (a missing or mismatched file, a name
# the bucket cannot hold, a file over wrangler's 300 MiB upload limit); STATE then records the
# attempt as failed. Other failures exit 1.
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in CI, or a `wrangler login` session.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 3 ]] || die "usage: scripts/publish.sh <bucket> <label> <site-dir>"
bucket=$1 label=$2
[[ $bucket =~ $BUCKET_RE ]] || die "bad bucket name: $bucket"
[[ $label =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$ ]] || die "bad label: $label"
[[ -d $3 && ! -L ${3%/} ]] || die "$3 is not a directory"
dir=$(cd "$3" && pwd -P)
id="$label.$(date -u +%Y%m%d%H%M%S)"
[[ $id =~ $ID_RE ]] || die "bad build id: $id"
bucket_check

# reject <reason>: the site itself cannot be published. STATE records the attempt as failed, so
# the scheduled workflow does not try the same release again, and the script exits 2. Problems with
# the bucket or the network exit 1 and leave STATE as it was.
reject() {
  echo "error: $*" >&2
  if state_read; then
    state_write "$state_current" "$state_previous" "$state_checked" "$id" || echo "warning: could not record $id as failed" >&2
  fi
  exit 2
}

links=$(find "$dir" -type l -print | head -n 1)
[[ -z $links ]] || reject "the site has a symbolic link: $links"
[[ -f $dir/index.html ]] || reject "the site has no index.html"

find "$dir" -type f -print0 >"$work/found" || die "could not list $dir"
files=()
while IFS= read -r -d '' file; do
  rel=${file#"$dir"/}
  case "/$rel" in */.* | */_*) continue ;; esac
  [[ $rel != MANIFEST && $rel != ROLLED_BACK ]] || reject "the site has a top-level file named $rel, which the bucket layout reserves"
  [[ $(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]') != *.wasm.br ]] || reject "the site has $rel; the .wasm.br copies are made by this script"
  # wrangler puts the key into a URL without escaping it, so only these characters are allowed.
  [[ $rel =~ ^[A-Za-z0-9._/-]+$ ]] || reject "the site has a file name wrangler cannot store as a key: $rel"
  # R2 keys are at most 1,024 bytes; these names are ASCII, so length in characters is the size.
  key="builds/$id/$rel"
  [[ $rel != *.wasm ]] || key="$key.br"
  [[ ${#key} -le 1024 ]] || reject "the key for $rel would be longer than R2's 1,024-byte limit"
  # `wrangler r2 object put` refuses files over 300 MiB.
  size=$(wc -c <"$file" | tr -d ' ')
  [[ $size -le 314572800 ]] || reject "$rel is $size bytes; wrangler uploads files of up to 300 MiB"
  files+=("$rel")
done < <(sort -z "$work/found")
[[ ${#files[@]} -gt 0 ]] || reject "the site has no files"

printf '%s\n' "${files[@]}" >"$work/files"

# Every file the page loads with an integrity value must match it before anything goes live:
# hashed names are served as immutable, so wrong bytes could stay in browsers after a rollback.
node "$lib_root/scripts/page-assets.mjs" "$dir/index.html" >"$work/assets" || reject "index.html cannot be checked"
while IFS=$'\t' read -r path integrity _; do
  [[ -n $path ]] || continue
  grep -qxF -- "$path" "$work/files" || reject "index.html loads $path, which is not a file this script uploads"
  [[ $integrity != - ]] || continue
  [[ $integrity == sha384-* ]] || reject "$path has an integrity value this script does not read: $integrity"
  got="sha384-$(openssl dgst -sha384 -binary "$dir/$path" | openssl base64 -A)" || die "could not compute the digest of $path"
  [[ $got == "$integrity" ]] || reject "$path does not match its integrity value in index.html"
done <"$work/assets"
# The page must run a script, not only preload one, and must load a .wasm (an external start-up
# script may pass a preloaded .wasm to init, which this check cannot see).
awk -F '\t' '$3 == 1 && $1 ~ /\.m?js$/ { f = 1 } END { exit !f }' "$work/assets" || reject "index.html runs no .js file"
awk -F '\t' '$1 ~ /\.wasm$/ { f = 1 } END { exit !f }' "$work/assets" || reject "index.html loads no .wasm file"

manifest="$work/MANIFEST"
: >"$manifest"
for rel in "${files[@]}"; do
  printf '%s\n' "builds/$id/$rel" >>"$manifest"
  if [[ $rel == *.wasm ]]; then printf '%s\n' "builds/$id/$rel.br" >>"$manifest"; fi
done
history_add "$id" || die "could not record $id in HISTORY"
put "builds/$id/MANIFEST" "$manifest"

for rel in "${files[@]}"; do
  put "builds/$id/$rel" "$dir/$rel"
  if [[ $rel == *.wasm ]]; then
    node "$lib_root/scripts/brotli.mjs" "$dir/$rel" "$work/packed.br"
    node "$lib_root/scripts/brotli.mjs" --check "$dir/$rel" "$work/packed.br"
    put "builds/$id/$rel.br" "$work/packed.br"
  fi
done
echo "uploaded ${#files[@]} files to $bucket/builds/$id/"

state_read || die "could not read STATE"
old=$state_current
# The id is written out before the switch, so the check and the rollback still run when the job
# stops between the switch and the end of this script.
if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "id=$id" >>"$GITHUB_OUTPUT"; fi
state_write "$id" "${old:-$state_previous}" "$state_checked" "$state_failed"
echo "current is now $id (was ${old:-nothing})"
echo "id=$id"
