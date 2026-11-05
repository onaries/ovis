### Fixed
- On the herdr-core runtime, an OpenCode pane's Chat shows its conversation instead of "Conversation
  unavailable": Ovis binds the pane to the session OpenCode's terminal title shows, among the sessions
  the pane reported while they worked or waited, so a session busy in another OpenCode tab never takes
  the pane's Chat. A pane shows its terminal while its session is untitled, OpenCode's terminal title
  is turned off, or its session has not worked since Ovis started.
