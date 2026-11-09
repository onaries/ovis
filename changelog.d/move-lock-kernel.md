### Fixed
- Two Ovis servers that find a dead holder of a herdr session's move lock can no longer both move it: the
  lock is now flock on a file in the session's folder, which the kernel alone arbitrates and nothing removes
  to take. A refused move no longer advises deleting the lock socket.
