#!/usr/bin/env bash
# Revert all commits authored today on the current branch.
# Default: dry run. Pass --execute to actually create the revert commits.
#
# Reverts run newest-first so each revert applies cleanly on top of the prior state.
# No pushes are performed; review and push yourself.

set -euo pipefail

EXECUTE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    -h|--help)
      echo "Usage: $0 [--execute]"
      echo "  (no flag)   Dry run — list commits that would be reverted."
      echo "  --execute   Create revert commits (newest-first, --no-edit)."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Refuse to run with a dirty tree — revert needs a clean index.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

# Today's commits on HEAD, newest-first.
mapfile -t COMMITS < <(git log --since="midnight" --pretty=format:"%H" HEAD)

if [ "${#COMMITS[@]}" -eq 0 ]; then
  echo "No commits authored today on $(git rev-parse --abbrev-ref HEAD)."
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Branch: $BRANCH"
echo "Commits authored today (newest-first, will be reverted in this order):"
echo
git log --since="midnight" --pretty=format:"  %h  %ai  %s" HEAD
echo
echo
echo "Total: ${#COMMITS[@]} commit(s)."

if [ "$EXECUTE" -eq 0 ]; then
  echo
  echo "Dry run. Re-run with --execute to create revert commits."
  exit 0
fi

echo
echo "Executing reverts..."
for sha in "${COMMITS[@]}"; do
  short=$(git rev-parse --short "$sha")
  subject=$(git log -1 --pretty=format:"%s" "$sha")
  echo "  reverting $short  $subject"
  if ! git revert --no-edit "$sha"; then
    echo >&2
    echo "Revert of $short failed — likely a conflict." >&2
    echo "Resolve the conflict, then run: git revert --continue" >&2
    echo "Or abort with: git revert --abort" >&2
    exit 1
  fi
done

echo
echo "Done. ${#COMMITS[@]} revert commit(s) created on $BRANCH."
echo "Review with: git log -${#COMMITS[@]} --oneline"
echo "Push when ready: git push"
