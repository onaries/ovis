### Fixed
- On herdr-core, a pane on another machine is named after its agent the way that machine's own
  platform names programs: a Windows machine's `letta.cmd` shows as Letta when Ovis runs on Linux,
  and a Linux machine's Command Code (`cmd`) is no longer hidden as the Windows command prompt when
  Ovis runs on Windows. Where the machine's platform cannot be told, such a pane names no agent
  rather than a wrong one. A terminal started directly as an agent is named from that start only
  while the process it started is still the one in front, so a pane started as `claude` that now
  runs Codex is Codex.
