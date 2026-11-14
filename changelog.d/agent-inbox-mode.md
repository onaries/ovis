### Added
- The agent inbox is a mode of its own, on a phone and on a desktop: **Open agent inbox** in the
  More menu and at the sidebar's foot lists every agent as a two-line row, the ones that need you
  first, and a row opens that agent's chat. On a wide window the list stays beside the chat, and
  the terminal is behind the thread's monitor button. **Back to Ovis** returns to the
  workspaces, and the mode has an address of its own (`?app=inbox`), so a reload or a link keeps
  it.
- A row that needs you says how long it has waited where this device saw the wait begin, and
  otherwise the time of the agent's last message, so every row of the list has a time.

### Fixed
- More closes when the button that opened it leaves the page (a Back that takes its screen away),
  instead of staying open over a screen it no longer belongs to.

### Maintenance
- The app marks the history entry a page loads on, and one left without a state when the page is
  hidden, so a restored tab is told from a fresh navigation; only the inbox mode's phone start
  reads the mark.
- The roster's loader keeps the state of its event stream (lost, back), which the inbox mode's
  list says; a drop or a reopen draws the app again, and Connected for two seconds after.
