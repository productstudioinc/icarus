#!/usr/bin/env bash
set -euo pipefail

REMOTE_NAME="${REMOTE_NAME:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-git@github.com:letta-ai/lettabot.git}"
BASE_BRANCH="${BASE_BRANCH:-main}"
MODE="${1:---merge}"

if [[ "$MODE" == "--rebase" ]]; then
  MODE="rebase"
elif [[ "$MODE" == "--merge" ]]; then
  MODE="merge"
fi

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote add "$REMOTE_NAME" "$UPSTREAM_URL"
fi

git fetch "$REMOTE_NAME"
git checkout "$BASE_BRANCH"

if [[ "$MODE" == "rebase" ]]; then
  git rebase "$REMOTE_NAME/$BASE_BRANCH"
else
  git merge "$REMOTE_NAME/$BASE_BRANCH"
fi
