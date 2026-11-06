### Changed
- The sidebar reads every repository's branches on a PC in one request every 30 s instead of one
  request per repository, so branch labels arrive in one round trip over the relay or another PC's
  connection (about 1.1 s to 0.16 s for eight repositories at a 133 ms round trip). A PC whose
  Ovis is older is still read one repository at a time.
