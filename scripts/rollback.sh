#!/usr/bin/env bash
# Serve the last checked build again after a published build fails its check.
#
# Usage: scripts/rollback.sh [--canceled] <bucket> <failed-id>
#
# When STATE's current is <failed-id>, STATE becomes current=<checked>, previous=<failed-id> and
# failed=<failed-id>, so pages that loaded the failed build can still fetch its files and the
# scheduled workflow does not publish the same release again. With --canceled (the check did not
# finish), failed is left as it was, so the next scheduled run tries the release again. With no
# checked build, current is emptied: the site answers 503 and the next scheduled run publishes
# again. Either way builds/<failed-id>/ROLLED_BACK is then written, which sends that build's start
# page to the current build. A rollback of the build that checked already names is refused, and
# STATE is not changed.
# The failed build is deleted by a later scripts/cleanup.sh once it leaves HISTORY and STATE.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

canceled=0
if [[ ${1:-} == --canceled ]]; then canceled=1; shift; fi
[[ $# -eq 2 ]] || die "usage: scripts/rollback.sh [--canceled] <bucket> <failed-id>"
bucket=$1 failed=$2
[[ $bucket =~ $BUCKET_RE ]] || die "bad bucket name: $bucket"
[[ $failed =~ $ID_RE ]] || die "bad build id: $failed"

state_read || die "could not read STATE"
if [[ $state_current != "$failed" ]]; then
  # A rollback that switched STATE but stopped before writing the marker is finished here.
  if [[ $state_previous == "$failed" ]]; then
    put_text "builds/$failed/ROLLED_BACK" "" || die "could not mark $failed as rolled back"
    echo "current is ${state_current:-nothing}; $failed is marked as rolled back"
    exit 0
  fi
  echo "current is ${state_current:-nothing}, not $failed; nothing to roll back"
  exit 0
fi
[[ $state_checked != "$failed" ]] || die "$failed is the checked build; there is no earlier build to go back to"
label() { printf '%s' "$1" | sed -E 's/\.[0-9]{14}$//'; }
mark=$failed
if [[ $canceled -eq 1 ]]; then
  # An inconclusive retry of a release that failed before clears that failure, so the next run
  # tries it again; a failure recorded for another release stays.
  mark=$state_failed
  if [[ -n $mark && $(label "$mark") == "$(label "$failed")" ]]; then mark=; fi
fi
if [[ -z $state_checked ]]; then
  state_write "" "$failed" "" "$mark"
  echo "no checked build: nothing is served until the next publish"
else
  state_write "$state_checked" "$failed" "$state_checked" "$mark"
  echo "current is $state_checked again"
fi
# The marker sends the failed build's start page to the current build (src/index.js). It is
# written after STATE, so the build is never marked while it is still current.
put_text "builds/$failed/ROLLED_BACK" "" || die "could not mark $failed as rolled back"
