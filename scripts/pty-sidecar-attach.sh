#!/bin/bash
# Attaches a built Rust PTY host set (scripts/pty-sidecar.ts build + manifest) to a published release:
# .github/workflows/pty-sidecar-attach.yml runs it, and scripts/pty-sidecar.test.ts runs it with a fake gh.
#   pty-sidecar-attach.sh <vX.Y.Z> <dir holding the set>   (GH_TOKEN and GH_REPO as gh reads them)
# Nothing is uploaded unless the release's asset list was read: a lookup that fails (an HTTP 502, a
# rate limit) must not be taken for "no host yet", or the binaries of a complete set would be replaced
# while its manifest stayed.
set -euo pipefail
tag=$1 dir=$2
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::'$tag' is not a release tag (vX.Y.Z)." >&2
  exit 1
fi
version=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$dir/ovis-pty-sidecar.json")
if [ "v$version" != "$tag" ]; then
  echo "::error::$tag's package.json says $version." >&2
  exit 1
fi
if ! assets=$(gh release view "$tag" --json assets --jq '.assets[].name'); then
  echo "::error::could not read $tag's assets, so nothing was uploaded; run this again." >&2
  exit 1
fi
# a complete set already attached stays: replacing it would let installs see a mix of two builds
if printf '%s\n' "$assets" | grep -qx ovis-pty-sidecar.json; then
  echo "::error::$tag already has the Rust PTY host." >&2
  exit 1
fi
# installs read the manifest first, so it goes last: until it is there, a release offers no host,
# and a run that failed halfway is repaired by running this again (--clobber replaces its binaries)
gh release upload "$tag" "$dir"/ovis-pty-sidecar-* "$dir/SHA256SUMS" --clobber
gh release upload "$tag" "$dir/ovis-pty-sidecar.json"
