### Fixed
- On Windows, installing a branch or a commit with `install.ps1` (`OVIS_REF`) builds it from its own
  sources, as `install.sh` does, instead of failing with "Cannot find module" while herdr runs. Running
  it again with `OVIS_REF` naming that branch or commit builds a branch an earlier install left on the
  release's binary from source. A build that fails or is cut off (Ctrl+C, a closed window, a restart)
  is built again by the next run, also one cut off while it installed its packages or over the
  packages and client of an earlier build: the plugin's launcher now marks a build from source as
  finished only once it is. Before it builds, the installer stops a server of an earlier build that
  herdr's start recorded as running, where the checkout can run that stop. Where a recorded server
  still runs after that (one started by hand among them), or the release's binary kept in the
  checkout cannot run the stop, nothing is built, and the installer says what to stop or remove
  before running it again. `OVIS_REF` naming another branch or commit than the installed one, or a branch that has moved
  since it was installed, is said, and nothing is stopped or changed.
- `install.sh` and `install.ps1` run again with `OVIS_REF` over an installed Ovis that needs no
  build say the commit it is at and that `OVIS_REF` does not move it, instead of nothing.
