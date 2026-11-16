### Fixed
- An install that finishes while another waits for it no longer fails with "Directory not empty": the
  waiter could take the install lock between the removal of the holder's pid and of its folder. The
  lock now leaves in one rename, and the next install removes one left by a run cut off meanwhile.
