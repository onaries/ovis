### Fixed
- A chat message, sent at once or from the queue, is no longer pasted onto text already typed in
  Codex's, pi's or OmO's own input box when it is sent: the send is refused and the message stays in
  the composer until that text is sent or cleared in the terminal. Text typed in the moment between
  that check and the paste can still be joined to the message. Their placeholders, a box the bridge
  cannot make out (pi with its command list open is one), and a terminal drawn without colour still
  send as before.
