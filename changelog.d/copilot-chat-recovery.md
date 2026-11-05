### Fixed
- Copilot Chat no longer stays on terminal output after Copilot rotates its process log: the
  rotated copy carries the session ownership forward, as reading the whole log would.
- Chat diagnostics use current wall-clock timestamps while keeping monotonic failure intervals.
### Changed
- When Copilot Chat cannot prove its conversation for a while, the messages already shown stay,
  marked paused, and update again on the agent's next activity instead of switching to terminal
  output.
### Maintenance
- Copilot Chat logs distinguish missing session evidence, lost log continuity, read races and
  explicit session releases. Reader bookkeeping shares one process-lifetime record and preserves
  the reason ownership was rejected without logging session IDs or conversation contents.
