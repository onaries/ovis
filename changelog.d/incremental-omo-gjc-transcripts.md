### Changed
- A long OMO or GJC chat refreshes faster while its agent works: each update now parses only the
  records the agent added since the last one, as OMP, Claude Code and Codex chats already do,
  instead of the whole running task again. Based on
  [#1634](https://github.com/devswha/ovis/pull/1634) by @Yoonwoo-Ha.
