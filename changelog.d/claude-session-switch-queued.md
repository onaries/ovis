### Fixed
- A message queued for a Claude Code conversation is no longer typed into another one when
  `/clear`, `/resume` or a `claude attach` job switches the pane's session while the message is
  being sent: the session is checked again right before the paste, and once the paste is in, an
  Enter is pressed only while the conversation can still be told. Otherwise the message is held
  before the paste, or left marked uncertain without its Enter.
