### Fixed
- On Linux, Codex Chat can read a project-local conversation store when the Codex launcher
  does not export `CODEX_HOME`. Ovis recognizes the store only while that process holds both
  its database and an interactive conversation file; an explicit `CODEX_HOME` keeps priority.
