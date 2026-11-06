### Added
- The server reads a pane's repository history: a page of commits with the branches and tags on
  them (`/api/workspace/git/log`), the local branches with their upstreams and how far ahead or
  behind they are (`/api/workspace/git/branches`), and one commit's whole message with the base
  its changes are read against (`/api/workspace/git/show`), on this PC or another one. The diff
  routes now read a root commit's changes against the empty tree.
