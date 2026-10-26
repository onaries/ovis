### Fixed
- Chat greets a Codex started by typing `codex` in a terminal, before its first message, as it
  does one started from the app, instead of saying the conversation is unavailable. It does so only
  when the screen shows Codex's start screen with nothing said, no `resume` or `fork` started
  it, and no conversation of that folder was begun or written since it started.
