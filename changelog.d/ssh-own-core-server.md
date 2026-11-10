### Fixed
- Connect SSH PCs running herdr-core through their own verified Ovis server, with a choice beside
  running herdr sessions and a runtime label on the PC. A PC whose chosen Ovis has stopped waits for
  it to come back (after a reboot, say) and starts nothing in its place; setting it up again offers to
  start a new herdr instead. PCs with no chosen runtime and no running sessions start herdr as before.
  An Ovis there that runs but cannot answer right now stays a choice instead of a new herdr being
  started, running herdr sessions are offered beside an older Ovis that does not list them, the
  bridge token never appears in a command on that PC, and the owner can list sessions on an Ovis
  without an access token from a paired device or their Tailscale login. Installing Ovis over an
  older herdr-core Ovis finds that server on its own socket, so it is never treated as gone while it
  still runs.
