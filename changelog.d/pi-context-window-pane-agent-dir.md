### Fixed
- On Linux, a pi pane started with its own `PI_CODING_AGENT_DIR` draws its context ring against
  the windows in that directory's model catalogs, not the ones in the server's. A pane whose
  profile cannot be told (its environment cannot be read, and its session store is shared rather
  than the one inside the server's own agent directory) draws no ring instead of the server's.
