#!/usr/bin/env bash
# Record that a build passed scripts/check.sh.
#
# Usage: scripts/mark-checked.sh <bucket> <id>
#
# Sets STATE's checked to <id> when <id> is still current, and clears failed when it names a build
# of the same tag or commit; otherwise leaves STATE as it is.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 2 ]] || die "usage: scripts/mark-checked.sh <bucket> <id>"
bucket=$1 id=$2
[[ $bucket =~ $BUCKET_RE ]] || die "bad bucket name: $bucket"
[[ $id =~ $ID_RE ]] || die "bad build id: $id"

state_read || die "could not read STATE"
if [[ $state_current != "$id" ]]; then
  die "current is ${state_current:-nothing}, not $id"
fi
# A pass clears a failure recorded for the same label (the tag or the commit).
label() { printf '%s' "$1" | sed -E 's/\.[0-9]{14}$//'; }
failed=$state_failed
if [[ -n $failed && $(label "$failed") == "$(label "$id")" ]]; then failed=; fi
state_write "$state_current" "$state_previous" "$id" "$failed"
echo "$id is checked"
