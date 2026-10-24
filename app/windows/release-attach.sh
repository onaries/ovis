#!/usr/bin/env bash
# Attaches Ovis for Windows' files to a release, all or nothing: the release's files always come from one build.
# Run by .github/workflows/windows-app.yml (GH_TOKEN, GH_REPO, RELEASE_TAG set).
#
#   release-attach.sh attach <build dir> <file>...   upload <dir>/<file> for each file and swap them in together
#   release-attach.sh recover <build dir> <file>...  after a failed or cancelled attach: leave one consistent build
#
# GitHub cannot replace a release asset in place, so a file is swapped in three steps. The new one is uploaded
# as NAME.uploading. The old one is renamed NAME.previous, and the new one takes NAME. Only when every file has
# been swapped (marked by an ovis-windows-swap.committed asset) are the .previous files deleted. Each asset keeps
# its own label ("built from <commit>").
set -euo pipefail

mode=$1
dir=$2
shift 2
files=("$@")
# recover needs no build: after a run cancelled before its files were downloaded, the label is unknown and unused
label="built from $(cat "$dir/build-source.txt" 2>/dev/null || echo unknown)"
release_id=$(gh api "repos/$GH_REPO/releases/tags/$RELEASE_TAG" --jq .id)

# one listing per question, as id<TAB>label of the asset with that name; a failed call stops the script (set -e)
asset() { gh api "repos/$GH_REPO/releases/$release_id/assets" --paginate --jq ".[] | select(.name == \"$1\") | [.id, (.label // \"\")] | @tsv"; }
# asset id, new name, label: retried, since a failure here is what can leave a release without its file
rename() {
  for _ in 1 2 3 4 5; do
    gh api -X PATCH "repos/$GH_REPO/releases/assets/$1" -f name="$2" -f label="$3" >/dev/null && return 0
    sleep 5
  done
  return 1
}
delete() { gh api -X DELETE "repos/$GH_REPO/releases/assets/$1"; }

# Every file this release can carry. Recovery always looks at all of them, whatever this run uploads, and a run
# that uploads only some of them takes the others out in the same swap, so the release never mixes builds.
known=(Ovis.exe Ovis.msix)
marker=ovis-windows-swap.committed

# Leaves the release with one build's files, whatever build runs it and whatever it uploads. The marker asset is
# uploaded only once every replaced file has been swapped (and every file this run does not carry has been set
# aside), and before a file new to the release takes its name or any .previous is deleted. With the marker, the
# swap is finished: a staged file whose name is free takes it, and every .previous goes. Without it, every
# .previous is put back and every staged file is dropped.
recover() {
  local name current previous staged committed
  committed=$(asset "$marker")
  for name in "${known[@]}"; do
    current=$(asset "$name")
    previous=$(asset "$name.previous")
    staged=$(asset "$name.uploading")
    if [ -n "$committed" ]; then
      if [ -n "$staged" ]; then
        if [ -z "$current" ]; then
          rename "$(cut -f1 <<<"$staged")" "$name" "$(cut -f2 <<<"$staged")" ||
            { echo "::error::$name.uploading on $RELEASE_TAG could not be renamed to $name; rename it by hand." >&2; return 1; }
        else
          delete "$(cut -f1 <<<"$staged")"
        fi
      fi
      [ -z "$previous" ] || delete "$(cut -f1 <<<"$previous")"
      continue
    fi
    [ -z "$staged" ] || delete "$(cut -f1 <<<"$staged")"
    [ -n "$previous" ] || continue
    # undo: the old file takes its name back, with its own label
    [ -z "$current" ] || delete "$(cut -f1 <<<"$current")"
    rename "$(cut -f1 <<<"$previous")" "$name" "$(cut -f2 <<<"$previous")" ||
      { echo "::error::$name.previous on $RELEASE_TAG could not be renamed back to $name; rename it by hand." >&2; return 1; }
    echo "::notice::$name.previous on $RELEASE_TAG was put back as $name."
  done
  [ -z "$committed" ] || delete "$(cut -f1 <<<"$committed")"
}

carried() { local f; for f in "${files[@]}"; do [ "$f" = "$1" ] && return 0; done; return 1; }

attach() {
  local name entry staged new_id old old_id old_label mark new_names=()
  # an earlier run that died mid-swap: one consistent build first, across every known file
  recover
  # 1. every new file goes up under its staging name; nothing the release serves changes yet
  for name in "${files[@]}"; do
    cp "$dir/$name" "$dir/$name.uploading"
    gh release upload "$RELEASE_TAG" "$dir/$name.uploading#$label" || { echo "::error::$name could not be uploaded to $RELEASE_TAG; nothing was changed." >&2; recover; return 1; }
    staged=$(asset "$name.uploading")
    [ -n "$staged" ] || { echo "::error::$name.uploading was uploaded but is not listed on $RELEASE_TAG." >&2; recover; return 1; }
  done
  # 2. each file that replaces an old one is swapped in: the old one steps aside, the new one takes its name.
  # A file this run does not carry steps aside too, so it leaves with the swap. A file new to the release waits
  # as NAME.uploading until the marker is up. Any failure undoes every swap.
  for name in "${known[@]}"; do
    old=$(asset "$name")
    if ! carried "$name"; then
      [ -n "$old" ] || continue
      rename "$(cut -f1 <<<"$old")" "$name.previous" "$(cut -f2 <<<"$old")" ||
        { echo "::error::$name on $RELEASE_TAG could not be moved aside; undoing this run's swaps." >&2; recover; return 1; }
      continue
    fi
    if [ -z "$old" ]; then new_names+=("$name"); continue; fi
    old_id=$(cut -f1 <<<"$old")
    old_label=$(cut -f2 <<<"$old")
    entry=$(asset "$name.uploading")
    new_id=$(cut -f1 <<<"$entry")
    if ! rename "$old_id" "$name.previous" "$old_label"; then
      echo "::error::$name on $RELEASE_TAG could not be moved aside; undoing this run's swaps." >&2
      recover
      return 1
    fi
    if ! rename "$new_id" "$name" "$label"; then
      echo "::error::$name.uploading on $RELEASE_TAG could not be renamed to $name; undoing this run's swaps." >&2
      recover
      return 1
    fi
  done
  # 3. mark the swap done; from here recover finishes it. Then files new to the release take their names, the
  # old files go, and the mark goes. A failure from here on is finished by the cleanup step's recover.
  # The mark is never empty: GitHub refuses a 0-byte asset upload (HTTP 400 Bad Content-Length).
  printf '%s\n' "$label" > "$dir/$marker"
  gh release upload "$RELEASE_TAG" "$dir/$marker#$label" || { echo "::error::the commit mark could not be uploaded; undoing this run's swaps." >&2; recover; return 1; }
  for name in "${new_names[@]}"; do
    entry=$(asset "$name.uploading")
    rename "$(cut -f1 <<<"$entry")" "$name" "$label" ||
      { echo "::error::$name.uploading on $RELEASE_TAG could not be renamed to $name; finishing in the cleanup step." >&2; return 1; }
  done
  for name in "${known[@]}"; do
    old=$(asset "$name.previous")
    [ -z "$old" ] || delete "$(cut -f1 <<<"$old")"
  done
  mark=$(asset "$marker")
  [ -z "$mark" ] || delete "$(cut -f1 <<<"$mark")"
}

case "$mode" in
  attach) attach ;;
  recover) recover ;;
  *) echo "usage: release-attach.sh attach|recover <build dir> <file>..." >&2; exit 2 ;;
esac
