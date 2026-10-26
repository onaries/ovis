### Fixed
- A Windows PC whose bridge install was interrupted (its dialog closed, the SSH link dropped, the
  app killed) no longer keeps `install.lock` forever: the next setup reclaims it, so
  "Another installation is in progress; retry shortly" no longer survives the failure that left it.
