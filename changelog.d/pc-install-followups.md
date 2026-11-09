### Fixed
- Cancelling an update of another PC asks that PC's own Ovis to stop that update only (by the id its
  install request was given), while it still checks or builds,
  and says it stopped only once that PC confirms it; otherwise (an older Ovis, or one already restarting)
  it says the update may still finish there, never that it ended.
- An install over SSH that finds an older Ovis there updates it only to the release and build shown
  (this app's own), and cancelling that install stops its update there too.
- One install or setup per PC holds even when ssh cannot resolve an address, and resolving addresses no
  longer holds the server up.
