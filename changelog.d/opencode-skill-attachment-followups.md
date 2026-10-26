### Fixed
- OpenCode: an `@skill` sent from Chat that did attach is no longer reported as not attached when
  the agent row redraws, a bordered line is on screen or the theme has no bold, and the message
  recorded for a send matches what was typed. If OpenCode shows that Tab switched its agent or
  attached another skill, nothing more is typed and the message stays in Chat.
- OpenCode: sending an `@skill` before the pane's skill list has loaded no longer pauses the server
  to scan the disk; the mention goes as plain text unless the skill is already known.
