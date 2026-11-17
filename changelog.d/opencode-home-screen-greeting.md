### Fixed
- An OpenCode pane at its home screen, before the first prompt, now shows the chat's greeting instead
  of "Conversation unavailable", as long as nothing suggests it shows a session: it was started with
  no `--continue`, `--session` or `--prompt`, and its folder has no session newer than the pane's
  OpenCode.
