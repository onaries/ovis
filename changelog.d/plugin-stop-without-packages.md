### Fixed
- The herdr plugin's `stop` and `status` work in a checkout whose package install was cut off, so a
  server that runs from it can still be stopped: they no longer load the QR code's, the relay's or
  the account's packages. The commands that need them fail there before they change anything: no
  pairing code is replaced and nothing is published to Tailscale.
- Phone setup run from a checkout passes a SIGTERM or SIGHUP, and on Linux and macOS a SIGINT, on to
  the installed release it starts, instead of ending and leaving that release running in the pane.
  Link and the other commands handed on to that release now pass a SIGINT on too.
- When a command the herdr plugin's launcher runs is ended by a signal other than SIGHUP, SIGINT or
  SIGTERM, the launcher now exits with 128 plus that signal's number (137 for SIGKILL), not 128.
