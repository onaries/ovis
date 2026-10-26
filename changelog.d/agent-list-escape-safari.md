### Fixed
- Escape on an open agent list in the New session, Earlier sessions and New worktree dialogs closes
  only the list in Safari too, where a list opened with the mouse leaves the focus off its button;
  before, that Escape closed the whole dialog. An overlay opened over the dialog, such as Add PC,
  still takes its own Escape.
