### Fixed
- On the herdr-core runtime, an OpenCode pane whose session rests through a restart or update of
  Ovis shows its conversation again instead of "Conversation unavailable": Ovis keeps the sessions a
  pane reported in its `ovis.opencode` terminal label and reads them back when it starts. A session
  already resting when this version first starts has no label yet; it is shown again once it works.
