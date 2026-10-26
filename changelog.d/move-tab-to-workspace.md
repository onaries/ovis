### Added
- A tab with one pane moves to another workspace: Move to workspace… in its right-click menu
  lists the workspaces, and the palette offers Move tab to {workspace}. The tab keeps its name
  and its pane's running process, and the view follows it, in either half of a split, with what
  was typed into it and not sent.
  ([#1427](https://github.com/devswha/herdr-web-ui/pull/1427) by @sergiorademacher)

### Fixed
- In a split view, an item of the tab menu opened in the inactive half (Rename tab, say) acts
  again: the press on it made the half active, which closed the menu before the item ran.
  ([#1427](https://github.com/devswha/herdr-web-ui/pull/1427))
