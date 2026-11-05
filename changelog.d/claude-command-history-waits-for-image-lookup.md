### Fixed
- A Claude session's background-command history no longer gives up and falls behind while a
  picture of the same transcript loads slowly, such as a first picture of a long transcript on an
  SSHFS home: its read now waits for the picture's lookup to end instead of timing out behind it.
