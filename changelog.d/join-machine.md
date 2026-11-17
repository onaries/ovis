### Added
- A trial way to add a Linux machine to an Ovis account by one pasted line, under the fleet preview
  (`scripts/join/`, not shipped by any release or installer): the line fetches `join.sh` and runs it
  only if its SHA-256 is the one the line names; `join.sh` checks every file of its kit against the
  kit's `SHA256SUMS` before it uses it, asks before it changes anything, installs a machine profile
  server (`OVIS_PROFILE=machine`, `OVIS_PREVIEW=fleet`) for the user who runs it into
  `~/.local/share/ovis-machine` with one systemd user unit, and runs `add` for it. It never uses
  root or sudo. Its printed undo line, and the roll back after a refusal or an interruption (Ctrl+C,
  TERM or a dropped connection), remove what it made: its unit, its server, its folder, lingering
  if it turned that on (or say how to turn it off when that fails), and the empty folders it made
  on the way. It names the account the machine is in, as the add shows it, and never calls that
  account yours.
