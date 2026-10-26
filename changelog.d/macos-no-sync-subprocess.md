### Fixed
- On macOS the server no longer pauses every connection while `ps` tells when an agent's process
  started or which terminal it runs in: it reads both from the kernel instead.
- Opening a file an agent named without its folder no longer pauses the server while git lists a
  large repository.
