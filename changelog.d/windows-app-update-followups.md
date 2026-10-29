### Fixed
- Ovis for Windows' Update for a server under the old id installs the newest release even when
  the PC sets an older `OVIS_REF`, and when the installer or herdr's reinstall fails, the server
  that ran before starts again, with or without herdr running. A running server that reports no
  version and runs without the update supervisor, such as one just started whose supervisor has
  not reported yet, is no longer offered Update, and the
  version check waits once more for a server slow to answer and takes a token set only in the
  environment.
