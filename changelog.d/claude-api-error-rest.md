### Fixed
- A Claude Code turn that ends on an API error (a rate limit, a cooldown, an overloaded model) now
  reads at rest in the sidebar, not as a finished DONE, and sends the failure alert instead of a
  finish alert. A retry that gets through afterwards finishes the turn as before.
