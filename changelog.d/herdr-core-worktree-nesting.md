### Fixed
- On a herdr-core server, a workspace on a linked git worktree is drawn under its repository's
  workspace with the worktree icon, as on herdr, also when the Herdr app arranges the core or the
  checkout was made outside Ovis (`git worktree add`, an agent's own worktree). As on herdr, such a
  workspace (any workspace inside a git repository, a home folder kept in git included) now opens a
  new tab, and looks up Earlier sessions, at the root of its checkout rather than in its pane's
  subfolder.
