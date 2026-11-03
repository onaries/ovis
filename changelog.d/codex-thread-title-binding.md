### Fixed
- Codex panes with an explicitly configured ID-only terminal title can identify their current
  thread without visible answer text, including after an Ovis restart. The bridge checks title
  configuration, process birth, terminal identity and unique thread IDs, and refuses missing or
  ambiguous title metadata. Codex's shared daemon remains supported.
