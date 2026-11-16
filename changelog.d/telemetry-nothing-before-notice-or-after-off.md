### Fixed
- The anonymous usage counts keep nothing before their notice has been shown: a visit from before it is
  no longer recorded and sent afterwards, and the settings are kept only from its acknowledgement on.
  Turning the counts off deletes everything not sent yet, the settings snapshot included, so nothing
  captured before is sent when they are turned on again: an install or update message still owed goes
  then without settings until a browser tells them again, and without the version it replaced.
