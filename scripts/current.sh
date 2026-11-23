#!/usr/bin/env bash
# Print STATE: the build the Worker serves, its fallback, the last checked build and the last build
# that failed its check.
#
# Usage: scripts/current.sh <bucket>
#
# Prints four lines, current=<id>, previous=<id>, checked=<id> and failed=<id>, each empty when
# unset. Exits
# nonzero when the bucket cannot be read, so a failed read is never taken for "nothing".
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 1 ]] || die "usage: scripts/current.sh <bucket>"
bucket=$1
[[ $bucket =~ $BUCKET_RE ]] || die "bad bucket name: $bucket"
bucket_check
state_read || die "could not read STATE"
printf 'current=%s\nprevious=%s\nchecked=%s\nfailed=%s\n' "$state_current" "$state_previous" "$state_checked" "$state_failed"
