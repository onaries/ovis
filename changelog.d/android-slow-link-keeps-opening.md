### Fixed
- The Android app no longer calls a PC unreachable after 20 seconds while its page is still
  arriving over a slow link: it gives up only when nothing came back, says "Slow connection"
  with a progress bar and how much has arrived, and offers Keep waiting when the link stops
  sending. A timeout to a public server no longer blames a home network or the PC's firewall.
