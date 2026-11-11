### Fixed
- On Windows, Ovis no longer runs an `hc` it finds outside your profile folder while it looks for
  herdr-core: not one on the PATH in a folder such as `C:\tools`, which every account on the PC
  can write, nor one in Program Files, nor a bare `OVIS_HC_BIN=hc` found there. Set
  `OVIS_HC_BIN` to the full path of an `hc` kept elsewhere.
