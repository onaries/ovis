#!/usr/bin/env bash
# Self-hosted jobs: start Bun's install cache from the runner host's copy, which
# scripts/self-hosted-runner/run.sh builds from the default branch's bun.lock and mounts read-only,
# so `bun install --frozen-lockfile` downloads only what this checkout's lockfile adds. Bun cannot
# install from a read-only cache, so the copy is the job's own. It takes the cache's name only once
# complete: Bun would take a half-copied package for a cached one.
set -euo pipefail

seed="${CI_HOST_BUN_CACHE:-/cache/bun/current}"
cache="${BUN_INSTALL_CACHE_DIR:?BUN_INSTALL_CACHE_DIR is required}"

# once: the launcher may point `current` at a newer version while this copies
seed="$(readlink -e "$seed" || true)"
if [[ -z "$seed" || ! -d "$seed" ]]; then
  echo "No Bun cache from the runner host: bun install downloads every package"
  exit 0
fi
if [[ -d "$cache" && -n "$(ls -A "$cache")" ]]; then
  echo "$cache already holds packages: left as it is"
  exit 0
fi

mkdir -p "$(dirname "$cache")"
tmp="$(mktemp -d "$cache.seed-XXXXXX")"
if cp -a "$seed/." "$tmp/" && { [[ ! -d "$cache" ]] || rmdir "$cache"; } && mv -T "$tmp" "$cache"; then
  echo "Bun cache seeded from the runner host ($(find "$cache" -mindepth 1 -maxdepth 1 | wc -l) entries)"
else
  rm -rf "$tmp"
  echo "::warning::Could not copy the runner host's Bun cache; bun install downloads every package"
fi
