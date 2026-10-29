### Maintenance
- The Windows plugin test that stops the server's process tree no longer fails now and then on
  CI: it took a process whose recorded parent number Windows had handed on to a server process
  for part of the tree, and waited for unrelated processes, its own test runner among them, to
  exit. It now walks the tree the way `stop` does, skipping a process older than its parent.
