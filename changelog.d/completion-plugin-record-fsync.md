### Fixed
- The finished agents kept across a restart, and the plugin's record of the server it started
  (`server.pid`, `server.owner`), are now flushed to disk before they replace the old file, so a
  power cut or forced shutdown right after a write can no longer leave them empty. On Windows the
  folder itself is not flushed.
