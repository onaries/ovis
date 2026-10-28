### Fixed
- A Claude Code pane whose turn has ended no longer reads as working while a background subagent it
  started works on: Claude Code keeps its busy title spinner up for the subagent, which herdr reads
  as work. The pane now waits on that work (BG), as it does when the subagent is quiet, so the chat
  no longer shows "Working…" with a Stop button under the finished answer. (#2069)
