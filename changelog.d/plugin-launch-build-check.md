### Changed
- The herdr plugin's launcher no longer starts a checkout that runs from source without a finished
  build (no packages, no built client, or a build that did not finish), unless `OVIS_FROM_SOURCE=1`
  or an earlier start or build step chose the sources for this version: it says what is missing and
  the command that builds it. Without such a choice, a finished build of another version still
  starts, with a notice that names both versions and the command that rebuilds it, and so does one
  of another commit, with that notice only where git can read the checkout's commit.

### Fixed
- The herdr plugin's stop and status actions run the checkout's own stop and status whenever the
  release's compiled server cannot be had, also while the release cannot be reached, so an Ovis
  running from that checkout can still be stopped.
