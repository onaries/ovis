### Fixed
- A Windows PC whose Ovis state folder was migrated connects over SSH again: the bridge's launcher and
  the bridge itself no longer go through the migration junction (`.config\herdr-web-ui`), which a
  process an SSH session starts may not traverse, so adding it no longer waits minutes and ends
  "Bridge did not start". The bridge's part takes effect with the next remote bundle.
