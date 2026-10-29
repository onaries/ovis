### Fixed
- The terminal no longer shows half of an agent's new screen over half of its old one while the
  agent streams, which happened most often with Korean text: the browser terminal is now xterm.js
  6, which draws a frame only once it is whole (#1617). Trackpad scrolling, Option+arrow word moves
  and Korean typing keep working as before.
