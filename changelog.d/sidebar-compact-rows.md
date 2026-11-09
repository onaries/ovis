### Changed
- The sidebar is denser, after herdr-app's list: one-line workspace rows, a branch shown while the
  pointer is on its row, and worktree names without herdr's `worktree-` prefix and hash. Settings →
  Sidebar rows → Two lines keeps the previous look.
- A waiting agent shows the same small `?` on its row and on its workspace's row; working is a dot
  and an unread finish a check, in the same place. A status change no longer moves the row under
  the pointer, or under a finger for a second after it lifts.
- Settings → Agents order has a new default, Waiting first: herdr's order with the agents that need
  you on top, each saying how long it has waited once the app saw the wait begin, and the resting
  ones folded into one `+N resting` line. A saved Workspaces or Activity order is kept, and the
  workspace list keeps herdr's order.
- Each PC's load (CPU and memory) stays off until it is chosen in Settings.

### Fixed
- Screen readers hear which PC an agent row belongs to.
