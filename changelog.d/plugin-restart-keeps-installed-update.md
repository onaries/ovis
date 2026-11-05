### Fixed
- A herdr plugin install started from a shell (`bun scripts/plugin.ts start`, without herdr's
  `HERDR_PLUGIN_ROOT`) runs the update it already installed again, instead of falling back to the
  plugin's original checkout. Updates still wait for herdr's own start.
