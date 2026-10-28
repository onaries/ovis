### Fixed
- Windows remote PCs wait for Windows sign-in before starting herdr, so Codex can use its
  private-desktop sandbox. Startup options offer an explicit start without sign-in for headless
  PCs, including when Task Scheduler cannot start herdr, with the error and sandbox and desktop-tool
  limitations shown before that one start. Existing herdr servers are reused without restarting
  their panes. Signing out of Windows ends a desktop-started herdr and its panes; lock the PC
  instead. SSH disconnects and bridge updates leave them running.
- Slow Windows launchers keep their startup options through the launch deadline. Failed startup
  reviews restore saved PCs' reconnection attempts; Task Scheduler failures show their own error
  instead of a sign-in instruction and stop background retries until startup options are reviewed.
