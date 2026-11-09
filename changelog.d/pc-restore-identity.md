### Fixed
- Starting a replaced server again (experimental) counts a server on the herdr session only while it is
  still the very process its registration names, waits for the one it started itself, and probes the
  port that server listened on; it does not start anything while this app is stopping.
- An install from the desktop app updates the PC's older Ovis to this app's own build, as the other
  runtimes do, when that build was made from a clean tree.
