### Fixed
- An omp Ask card now shows the question and its options in the agent's own Markdown (bold, code,
  links, lists, a fenced block), and a question omp cuts at four rows in full. The card takes the
  text from the session's open ask call only when it matches the menu on screen; otherwise it
  shows the screen's text as before, and the answer keys still come from the terminal's menu.
