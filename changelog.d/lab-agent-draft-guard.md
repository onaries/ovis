### Fixed
- A chat message is no longer pasted onto text already typed in Letta Code's, maki's, Kimi Code's,
  Gemini CLI's or Kilo's own input box: the send is refused and the message stays in the composer.
  Text typed in the moment between that check and the paste can still be joined to the message. Their
  placeholders, a slash command Kimi Code or Gemini CLI draws as a command, and typed text drawn in a
  theme colour that was not recorded still send as before.
- Claude Code: Send anyway is also withheld over a paste Claude cut short into a
  `[...Truncated text #N +M lines...]` placeholder.
