### Fixed
- Two Ovis servers on one state folder no longer undo each other's anonymous usage counts changes: they
  take turns through a lock file, a change that cannot wait for the other is not recorded rather than
  written over it, turning the counts off always goes, and a lock left by a stopped server is taken over.
