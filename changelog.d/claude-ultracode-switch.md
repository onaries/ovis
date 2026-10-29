### Added
- New workspace and New tab have an Ultracode switch for Claude Code, on one line under Model and
  Effort, so a session can start with Ultracode on at any effort level
  (`--settings '{"ultracode":true}'`, which a Windows PC passes as a small settings file in
  `%LOCALAPPDATA%\ovis\claude-settings`). It needs Claude Code 2.1.284 or later, a model with xhigh
  and dynamic workflows on. Reported by @fivetaku, whose #2282 suggested the compact line under the
  effort level.
- Claude Code's `/effort` card has a Turn Ultracode on or Turn Ultracode off row where Tab, the
  default key, flips the switch: it switches Ultracode for this session and keeps the effort level.

### Changed
- New workspace and New tab no longer list `ultracode` among Claude Code's effort levels; the PC
  still accepts `--effort ultracode` from other clients.

### Fixed
- Claude Code's `/effort` card now shows while Ultracode is on, at max where Claude Code offers no
  Ultracode, and in panes narrower than 70 columns down to about 45, where the slider was left to
  the terminal before. A pane of about 44 columns or fewer still leaves it there, as Claude Code
  cuts the level names.
