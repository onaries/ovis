#!/usr/bin/env bash
# Picks the runner for ci.yml's Linux jobs and prints `linux=<json>` for $GITHUB_OUTPUT.
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. Otherwise the workflow_dispatch input wins over the repository variable
# CI_SELF_HOSTED_LABELS. With neither, a push or a same-repository pull request goes to the
# maintainer PC's runners (scripts/self-hosted-runner/, label self-hosted-ovis) and any other event
# stays on ubuntu-24.04. The variable value "ubuntu-24.04" (a JSON string, which pages.yml and
# release.yml also accept) keeps every job hosted while that PC is offline. A push to main takes the
# repository variable CI_MAIN_SELF_HOSTED_LABELS over CI_SELF_HOSTED_LABELS when it is set, so main's
# runs go to runners pull requests never use (run.sh --reserved); "ubuntu-24.04" there keeps only
# main hosted, and deleting it puts main back on the shared runners. This script runs from the
# checked-out revision, which a fork pull request controls; the runner itself refuses fork code
# (scripts/self-hosted-runner/job-started.sh).
set -euo pipefail

hosted='"ubuntu-24.04"'
default_labels='["self-hosted","self-hosted-ovis"]'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"
main_configured="${MAIN_LABELS:-}"

choose_labels() {
  local source="$1" value="$2" compact
  if ! compact=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$value" 2>/dev/null); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "linux=$compact"
}

if [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ "${configured//[[:space:]]/}" == "$hosted" ]]; then
  echo "Runner: ubuntu-24.04 (from repository variable CI_SELF_HOSTED_LABELS)" >&2
  echo "linux=$hosted"
elif [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${main_configured//[[:space:]]/}" ]]; then
  if [[ "${main_configured//[[:space:]]/}" == "$hosted" ]]; then
    echo "Runner: ubuntu-24.04 (push to main, from repository variable CI_MAIN_SELF_HOSTED_LABELS)" >&2
    echo "linux=$hosted"
  else
    choose_labels "repository variable CI_MAIN_SELF_HOSTED_LABELS" "$main_configured"
  fi
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable CI_SELF_HOSTED_LABELS" "$configured"
elif [[ "$event" == push || "$event" == pull_request ]]; then
  choose_labels "default for $event (CI_SELF_HOSTED_LABELS unset)" "$default_labels"
else
  echo "Runner: ubuntu-24.04 ($event, CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
