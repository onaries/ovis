### Changed
- A terminal that has been following new output at the bottom for a second reads its scroll
  position every 1 to 2 s instead of every 250 ms, so a busy pane no longer sends four requests a
  second. New output after a quiet spell, scrolling (the mouse wheel and swipes included),
  resizing, paging and search still read it at once, and a page asked for on a position read
  before the latest output reads it again first.
