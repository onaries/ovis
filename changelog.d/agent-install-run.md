### Added
- An agent can be installed and signed in to from Ovis: the server opens a terminal tab on that PC
  and types the vendor's own install command for it, or the agent's own sign-in, so every line
  shows and Ctrl+C stops it (`POST /api/agent-catalog/install` and `/sign-in`, also for remote
  PCs). A setup card follows the install, finds the agent once it is in place, and offers its
  sign-in.
