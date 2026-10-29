### Fixed
- Sending an `@skill` to OpenCode no longer types a second space after the skill when the pane redraws
  blank while Ovis waits for Tab's result.
- On Windows, Hermes transcripts, session history and skills are found under `%LOCALAPPDATA%\hermes`,
  where Hermes 0.21.5 keeps them (a store an earlier Hermes left in `%USERPROFILE%\.hermes` is still
  read), and agent stores are looked up under USERPROFILE even when HOME is set for Git or Emacs.
