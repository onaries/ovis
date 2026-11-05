### Added
- On a herdr-core whose layout no Herdr app keeps (the desktop app's own core), panes can be split,
  resized, swapped, zoomed and named, and workspaces and tabs reordered. Ovis keeps the order and
  splits in its own `ovis-layout` document on the core (docs/herdr-core-layout.md).

### Fixed
- Panes in a split tab on herdr-core keep their size instead of shrinking each other while they are
  viewed: a tab is now laid out from its split tree, not from its terminals' sizes.
