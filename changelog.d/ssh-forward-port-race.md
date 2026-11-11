### Fixed
- On Windows with Git for Windows' ssh (the one Ovis uses when Git is installed), a program that
  happens to hold the local tunnel port when Ovis connects to an SSH PC no longer receives that PC's
  bridge access token: the connection waits for ssh to report that its own forward is open, and fails
  with ssh's own error when the port is taken. With Windows' own OpenSSH, which reports nothing of this
  to Ovis, the connection works as before. A program that takes the port on purpose can still share it
  with ssh on Windows; that case is not closed yet.
