### Changed
- The terminal now always draws with libghostty, the terminal engine of Ghostty, and falls back to the
  classic xterm.js renderer by itself where libghostty cannot draw a pane. On a PC that runs herdr-core,
  as the desktop app does, it also shows the pictures a program sends with the Kitty graphics protocol
  (kitty icat, timg, chafa). Typing, selection, links and search still go through xterm.js underneath.
