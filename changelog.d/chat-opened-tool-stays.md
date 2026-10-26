### Fixed
- Chat no longer drags a tool you opened up and away while the agent keeps working: opening a tool,
  a folded block or a whole output stops following the end, as scrolling up does, until you go back
  to it. A GJC session that writes its file again with the same turns (when it trims old tool
  outputs) no longer folds what you opened or moves you, and a todo update you opened stays open
  when the next one joins it in a Plan row.
