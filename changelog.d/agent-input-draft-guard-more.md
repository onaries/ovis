### Fixed
- A chat message is no longer pasted onto text already typed in GJC's, Muse's, Qwen Code's, cline's or
  dsh-tui's own input box, nor in an OmO that herdr names Claude Code: the send is refused and the message
  stays in the composer. Text typed in the moment between that check and the paste can still be joined to
  the message. Their placeholders, a GJC draft longer than one row, a box the bridge cannot make out
  (dsh-tui with its command list open), and typed text drawn in a theme colour that was not recorded still
  send as before.
