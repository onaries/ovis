### Added
- The connection server can put right a PC reached over SSH whose Ovis cannot update itself (started
  by hand, or too old to take an update asked for from another PC): `POST /api/machines/install`
  installs Ovis there with its official installer at this app's release, or restarts it through its
  own launcher, then updates and connects it again. It can also give a PC with no Ovis yet one the
  same way. SSH uses keys only, and a refusal says what to do. The PC's card offers it in a later
  release.

### Changed
- Only one setup at a time connects to a PC over SSH, whatever herdr session each names: a second
  one, for another session or another PC saved at that address, waits until the first ends. An
  alias of a host, or its default port given, is the same PC (as `ssh -G` resolves it).
- Connecting to a PC whose own Ovis has just started waits for its first check for releases,
  rather than reading that it offers no update.

### Fixed
- Cancel now stops an automatic bridge update that is already running, not only one waiting its
  turn, and a bridge update no longer starts while the PC's own Ovis updates itself.
