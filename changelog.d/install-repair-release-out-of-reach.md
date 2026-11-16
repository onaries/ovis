### Fixed
- On Windows, `install.ps1` run again with `OVIS_REF` over a branch no longer stops Ovis to rebuild
  it while the release cannot be reached and the checkout keeps no release binary the launcher runs
  without it: if that build failed too (offline), herdr could not start Ovis again until the release
  was back. It says so, and nothing is stopped or changed. The commands it prints to build the
  checkout, and to find a server that may still run from it, work for a folder whose name has an
  apostrophe (`C:\Users\O'Brien\...`) or brackets, and the steps after a build during which the
  checkout moved to another version are one command per line.
