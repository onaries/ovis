### Fixed
- Codex Chat names literal shell command constants passed directly to exec_command.
  Concatenated constants show only a proven executable prefix with an ellipsis;
  dynamic arguments remain unknown and the original script stays available in the details.
