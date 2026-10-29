### Fixed
- Chat shows what Claude wrote right before a question card, read from the terminal, while the card
  waits. Claude Code 2.1.311 saves those words to its session file only with the answer, so the card
  lacked the context the terminal showed above the question. Words whose start is above the
  terminal's screen are left to the terminal, and once Claude's own record of the turn arrives the
  chat shows that instead. Reported by @Xelanor.
