### Fixed
- A terminal resized while it attaches no longer shows its first screen at the old size, or takes
  input before the program has the new size. The bridge now waits for herdr's redraw at the
  terminal's current size, also after a resize back to the size it started at, for up to a
  second.
