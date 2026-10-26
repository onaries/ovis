### Fixed
- A pane's unsent message, terminal line, held input, held chat messages and lens no longer show
  up in another pane after herdr restarts and gives its pane IDs out again. The earlier text waits
  in **Recover unsent text** in the pane's menu, where it can be put back in a message box (never
  sent), copied or discarded. A server restart alone keeps everything in place. Text kept before
  this update waits there too on the first load, since nothing says which herdr it was written for.
