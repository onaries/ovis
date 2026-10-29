### Fixed
- Read DONE dots no longer come back after herdr restarts on a PC: a late read of the old herdr run
  could make the server drop the new run's read finishes and stop saving new ones.
