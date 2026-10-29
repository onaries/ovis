### Fixed
- Opening, previewing or looking up a file on a slow or stalled disk (a network share, a large
  rendered page) no longer freezes every terminal and request: the file routes read the disk on a
  few background threads, and answer 503 to try again when those are busy or the disk does not
  answer in time.
