### Fixed
- An OmO question card with several questions now moves between them without an answer, as Tab
  and Shift+Tab do in the terminal: tap another question's step, or use Back and the new Next
  button. Codex's question card gets Back and Next (its ←/→), and Hermes's batch of questions
  gets its steps, Back and Next (its Tab and Shift+Tab). Each move sends the agent's own key and
  waits until the screen shows the question it moved to. If the screen shows anything else, the
  card stops and sends nothing more.
