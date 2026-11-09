### Fixed
- Sign in to Ovis on the relay tab of Add a connection opens the Ovis sign-in page in a new tab,
  with the code filled in, and comes back signed in, instead of sending you to Settings.
  Keyboard focus follows the sign-in steps, completion stays available to screen readers, and
  cancelling before the sign-in page opens closes the blank tab. Once opened, the page stays
  open, but its cancelled code cannot sign this window in. If the link page is unavailable,
  sign-in uses a device provider offered by the account service.
