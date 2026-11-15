#!/bin/sh
# Puts the pinned hc-tui source in ./upstream with ./patches applied, so that cargo can build this
# crate against it (Cargo.toml names upstream/crates/hc-tui and upstream/crates/hc-proto by path).
#
#   crates/ovis-tui/prepare.sh
#
# It fetches one commit (UPSTREAM names it) and that commit's Ghostty submodule, checks both commit
# ids, applies every patch and commits them there, so a clean `git status` in ./upstream means the
# tree is exactly "the pin plus our patches". A tree that is already that is left alone. A tree with
# edits of its own is never deleted: the script stops and says so.
#
# HC_TUI_REPO_OVERRIDE names another place to fetch the same commit from (a local clone, a mirror).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -n "$here" ] && [ -f "$here/UPSTREAM" ] || { echo "prepare.sh: UPSTREAM is missing beside the script" >&2; exit 1; }
# shellcheck disable=SC1091
. "$here/UPSTREAM"
dest="$here/upstream"
stamp="$dest/.ovis-prepared"

# what the tree must be made from: the pin and the bytes of every patch, in order
if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum; }
elif command -v shasum >/dev/null 2>&1; then hash() { shasum -a 256; }
else echo "prepare.sh: needs sha256sum or shasum" >&2; exit 1
fi
want=$( { printf '%s %s\n' "$HC_TUI_COMMIT" "$GHOSTTY_COMMIT"; for patch in "$here"/patches/*.patch; do [ -f "$patch" ] && cat "$patch"; done; } | hash | cut -d' ' -f1)
[ -n "$want" ] || { echo "prepare.sh: could not hash the pin and the patches" >&2; exit 1; }

if [ -e "$dest" ] && [ ! -d "$dest/.git" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  echo "prepare.sh: $dest is not a checkout this script made. Move it away, then run this again." >&2
  exit 1
fi

if [ -d "$dest/.git" ]; then
  # the tree is this script's own only while it is exactly the commit the script made last (the
  # stamp's second line), or the bare pin, with no edits and no untracked files: anything else is
  # someone's work, which is never deleted
  made=$(sed -n 2p "$stamp" 2>/dev/null || true)
  head=$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)
  edits=$(git -C "$dest" status --porcelain --ignore-submodules=untracked | grep -v -x '?? .ovis-prepared' || true)
  if [ -n "$edits" ] || { [ "$head" != "$made" ] && [ "$head" != "$HC_TUI_COMMIT" ]; }; then
    echo "prepare.sh: $dest has work of its own (edits, untracked files, or commits not exported to $here/patches). Export it (git -C upstream format-patch), or delete the folder, then run this again." >&2
    exit 1
  fi
  # reused only when it is the very commit made for these patches: the bare pin is made again
  if [ "$head" = "$made" ] && [ "$(sed -n 1p "$stamp" 2>/dev/null || true)" = "$want" ]; then
    exit 0
  fi
fi

rm -rf "$dest"
mkdir -p "$dest"
git -C "$dest" init --quiet
git -C "$dest" fetch --quiet --depth 1 "${HC_TUI_REPO_OVERRIDE:-$HC_TUI_REPO}" "$HC_TUI_COMMIT"
git -C "$dest" checkout --quiet --detach FETCH_HEAD
got=$(git -C "$dest" rev-parse HEAD)
[ "$got" = "$HC_TUI_COMMIT" ] || { echo "prepare.sh: fetched $got, not the pinned $HC_TUI_COMMIT" >&2; exit 1; }
git -C "$dest" submodule --quiet update --init --depth 1
got=$(git -C "$dest/vendor/ghostty" rev-parse HEAD)
[ "$got" = "$GHOSTTY_COMMIT" ] || { echo "prepare.sh: vendor/ghostty is $got, not the pinned $GHOSTTY_COMMIT" >&2; exit 1; }

applied=0
for patch in "$here"/patches/*.patch; do
  [ -f "$patch" ] || continue
  git -C "$dest" apply --index "$patch" || { echo "prepare.sh: $patch does not apply to $HC_TUI_COMMIT" >&2; exit 1; }
  applied=$((applied + 1))
done
if [ "$applied" -gt 0 ]; then
  git -C "$dest" -c user.name=ovis-tui -c user.email=ovis-tui@users.noreply.github.com commit --quiet -m "Ovis patches on hc-tui $HC_TUI_TAG ($applied)"
fi
printf '%s\n%s\n' "$want" "$(git -C "$dest" rev-parse HEAD)" > "$stamp"
echo "prepare.sh: hc-tui $HC_TUI_TAG ($HC_TUI_COMMIT) with $applied patch(es) is in $dest"
