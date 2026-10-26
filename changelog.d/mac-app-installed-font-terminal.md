### Fixed
- In Ovis for Mac's window, the terminal no longer draws Korean larger than its cells, or rows over
  each other, on a Mac with fonts such as JetBrains Mono or D2Coding installed: the app's web view
  draws an installed font but cannot measure it, so the terminal now uses the system's fonts there,
  as in Safari.
