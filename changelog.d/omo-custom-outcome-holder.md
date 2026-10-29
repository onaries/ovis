### Fixed
- A command sent to a custom OmO (one whose launcher does not name omo) keeps its row in Chat after
  the turn ends: the row follows the OmO process that holds the session, as a queued message does,
  instead of the bundled Claude SDK process that exits with each turn.
