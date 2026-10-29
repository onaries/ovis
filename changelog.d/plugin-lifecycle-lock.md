### Fixed
- Two plugin starts at the same moment, such as herdr's startup hook and the Start action, no
  longer leave `stop` saying Ovis is not running while a server keeps going: starts and stops take
  turns, one that waits says so in the plugin's log, and a start no longer opens a second server
  while one an earlier start left running (herdr away, say) still runs.
