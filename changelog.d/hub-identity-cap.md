### Fixed
- A hidden Hub account listed under many files stays unread whichever of its files changes email, and
  when what Ovis learned of hidden accounts is too large to save, the next start reads no Hub account
  instead of trusting an older list that knows less of them (unless the disk refuses that write too,
  which leaves the older list in place).
