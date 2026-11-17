### Fixed
- Ovis for Windows shows an Ovis server that `install.ps1` installed (the release's compiled server,
  0.5.4 and newer) as running when it answers, instead of "Not running" with a Start that failed
  with "Could not stop the Ovis server". The app now runs that install's own commands (its
  `run.ps1`) for the status, Start, Restart, Remove and the phone address. Start reads the PC again
  first: a server that runs by now (started from herdr or a terminal since the window last looked)
  is shown as running, not stopped and started again under the people using it.
