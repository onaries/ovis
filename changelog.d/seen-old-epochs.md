### Fixed
- The server no longer keeps or hands out the read finishes of a herdr run it knows has ended, so a
  browser that reconnects stops writing them back into its storage, and the next change drops them
  from `seen.json`. The records of a PC this server has not heard from since it started are kept.
