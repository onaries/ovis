### Fixed
- OpenCode's shared event connection now closes when a snapshot confirms its last pane stopped
  running OpenCode, even when no status event arrived, without dropping it during server handover.
