### Fixed
- The herdr plugin's launcher no longer fails on every command where git is not on PATH. Such a
  checkout runs from source, saying why: the release's compiled server is taken only for sources git
  can show it was built from. It does so without asking the release, so an already built checkout
  also starts while the release cannot be reached; one whose build is not complete is not started,
  and the launcher says how to build it.
