#!/usr/bin/env bash
# Delete the builds that fall out of HISTORY.
#
# Usage: scripts/cleanup.sh <bucket>
#
# HISTORY lists build ids, oldest first; scripts/publish.sh adds each build when its upload starts,
# so a build whose upload stopped part way is listed too. Every id beyond the last KEEP (default 3)
# is deleted, file by file from its MANIFEST, except STATE's current, previous and checked. A build whose
# deletion does not fully succeed keeps its MANIFEST and stays in HISTORY, so the next cleanup tries
# again; the script then exits nonzero after saving HISTORY.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 1 ]] || die "usage: scripts/cleanup.sh <bucket>"
bucket=$1
keep=${KEEP:-3}
[[ $bucket =~ $BUCKET_RE ]] || die "bad bucket name: $bucket"
[[ $keep =~ ^[0-9]+$ && $keep -ge 2 ]] || die "KEEP must be 2 or more"

state_read || die "could not read STATE"
history=$(get_text HISTORY) || die "could not read HISTORY"

ids=()
while IFS= read -r line; do
  line=$(trim "$line")
  if [[ -n $line && $line =~ $ID_RE ]]; then ids+=("$line"); fi
done <<<"$history"
if [[ ${#ids[@]} -eq 0 ]]; then
  echo "HISTORY is empty"
  exit 0
fi

remaining=()
deferred=0
drop=$((${#ids[@]} - keep))
for i in "${!ids[@]}"; do
  gone=${ids[$i]}
  if [[ $i -ge $drop || $gone == "$state_current" || $gone == "$state_previous" || $gone == "$state_checked" ]]; then
    remaining+=("$gone")
    continue
  fi
  if ! list=$(get_text "builds/$gone/MANIFEST"); then
    echo "warning: could not read the MANIFEST of $gone; keeping it for the next cleanup" >&2
    remaining+=("$gone")
    deferred=$((deferred + 1))
    continue
  fi
  echo "deleting build $gone"
  ok=1
  while IFS= read -r key; do
    if [[ $key == "builds/$gone/"* ]]; then delete "$key" || ok=0; fi
  done <<<"$list"
  if [[ $ok -eq 1 ]] && delete "builds/$gone/MANIFEST"; then continue; fi
  remaining+=("$gone")
  deferred=$((deferred + 1))
done

put_text HISTORY "$(printf '%s\n' "${remaining[@]}")"
echo "HISTORY: ${remaining[*]}"
if [[ $deferred -gt 0 ]]; then die "$deferred old build(s) could not be deleted; the next cleanup tries again"; fi
