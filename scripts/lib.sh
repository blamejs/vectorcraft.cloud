# shellcheck shell=bash
# Shared helpers for the bucket scripts; sourced, not run. Callers set `bucket` and `work` (a
# temporary directory) first, and run under `set -euo pipefail`. Bash turns errexit off inside
# $(...) and in functions called from a condition, so every helper returns its failures explicitly.

die() { echo "error: $*" >&2; exit 1; }

lib_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
BUCKET_RE='^[a-z0-9][a-z0-9-]{1,62}$'

wr() { (cd "$lib_root" && npx --no-install wrangler "$@"); }

# put <key> <file>: uploads with up to three tries; exits on failure.
put() {
  local i
  for i in 1 2 3; do
    if wr r2 object put "$bucket/$1" --file "$2" --remote >/dev/null 2>"$work/put.err"; then return 0; fi
    echo "retrying upload of $1: $(tail -n 3 "$work/put.err" | tr '\n' ' ')" >&2
    sleep $((i * 5))
  done
  die "upload of $1 failed"
}

# put_text <key> <text>
put_text() {
  printf '%s\n' "$2" >"$work/put.txt" || return 1
  put "$1" "$work/put.txt"
}

# get_text <key>: prints the object's text, or nothing when the key does not exist. Any other
# failure is retried and then returns 1, so a failed read is never taken for a missing key.
get_text() {
  local i
  for i in 1 2 3; do
    rm -f "$work/get.out"
    if wr r2 object get "$bucket/$1" --remote --file "$work/get.out" >/dev/null 2>"$work/get.err"; then
      cat "$work/get.out" || return 1
      return 0
    fi
    if grep -q 'The specified key does not exist' "$work/get.err"; then return 0; fi
    echo "retrying read of $1: $(tail -n 3 "$work/get.err" | tr '\n' ' ')" >&2
    sleep $((i * 5))
  done
  echo "error: read of $1 failed" >&2
  return 1
}

# bucket_check: exits unless the bucket exists. wrangler reports a missing bucket on `r2 object get`
# with the same message as a missing key, so the scripts check the bucket before reading STATE.
# With CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set (CI), the check asks the R2 bucket
# endpoint; `wrangler r2 bucket info` also reads bucket metrics, which an R2-only token may not
# read. Without them (a `wrangler login` session, whose login can read the metrics), it runs
# `wrangler r2 bucket info`.
bucket_check() {
  local code
  if [[ -n ${CLOUDFLARE_API_TOKEN:-} && -n ${CLOUDFLARE_ACCOUNT_ID:-} ]]; then
    code=$(curl -sS -o "$work/bucket.json" -w '%{http_code}' --max-time 60 \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$bucket") || code=000
    case $code in
      200) return 0 ;;
      404) die "bucket $bucket does not exist" ;;
      *) die "bucket $bucket cannot be read (HTTP $code): $(head -c 300 "$work/bucket.json" 2>/dev/null | tr '\n' ' ')" ;;
    esac
  fi
  if ! wr r2 bucket info "$bucket" >/dev/null 2>"$work/bucket.err"; then
    sed -e 's/\x1b\[[0-9;]*m//g' "$work/bucket.err" | grep -vE '^[[:space:]]*$|Logs were written|wrangler [0-9]|^─' >&2 || true
    die "bucket $bucket cannot be read"
  fi
}

# delete <key>: returns nonzero when the delete fails. A key that does not exist counts as deleted.
delete() {
  if wr r2 object delete "$bucket/$1" --remote >/dev/null 2>"$work/del.err"; then return 0; fi
  if grep -q 'The specified key does not exist' "$work/del.err"; then return 0; fi
  echo "warning: could not delete $1: $(tail -n 3 "$work/del.err" | tr '\n' ' ')" >&2
  return 1
}

# trim <text>: the text without leading and trailing whitespace.
trim() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}

# STATE is one object, so the served build, its fallback and the last checked build change
# together:
#   current=<id>   the build the Worker serves (empty: none)
#   previous=<id>  the build the Worker falls back to for files missing from current
#   checked=<id>   the last build that passed scripts/check.sh; a rollback goes back to it
#   failed=<id>    the last build that failed its check and was rolled back
#
# The scripts read STATE and write it back whole, so only one of them may run at a time; the
# workflow's concurrency group does that for its own runs.
#
# state_read: sets state_current, state_previous, state_checked and state_failed; returns 1 on a
# failed read or a malformed value.
state_read() {
  local text line k v
  state_current= state_previous= state_checked= state_failed=
  text=$(get_text STATE) || return 1
  while IFS= read -r line; do
    line=$(trim "$line")
    [[ -z $line ]] && continue
    k=$(trim "${line%%=*}") v=$(trim "${line#*=}")
    if [[ $line != *=* || ( -n $v && ! $v =~ $ID_RE ) ]]; then
      echo "error: STATE has a malformed line: $line" >&2
      return 1
    fi
    case $k in
      current) state_current=$v ;;
      previous) state_previous=$v ;;
      checked) state_checked=$v ;;
      failed) state_failed=$v ;;
      *) echo "error: STATE has an unknown key: $k" >&2; return 1 ;;
    esac
  done <<<"$text"
}

# state_write <current> <previous> <checked> <failed>
state_write() {
  put_text STATE "$(printf 'current=%s\nprevious=%s\nchecked=%s\nfailed=%s' "$1" "$2" "$3" "$4")"
}

# history_add <id>: appends <id> to HISTORY unless it is already there.
history_add() {
  local h
  h=$(get_text HISTORY) || return 1
  if printf '%s\n' "$h" | tr -d '\r' | grep -qxF "$1"; then return 0; fi
  put_text HISTORY "$(printf '%s\n%s\n' "$h" "$1" | grep -v '^[[:space:]]*$')"
}
