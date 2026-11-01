### Fixed
- Codex Chat on macOS can read a conversation behind Kiro's shell-integration terminal wrapper
  when the wrapper's nested foreground Codex is uniquely proven, even without a herdr agent label.
- Cached nested conversations also require matching wrapper, shell and Codex process start times,
  so reused process IDs cannot retain a previous conversation's binding.
