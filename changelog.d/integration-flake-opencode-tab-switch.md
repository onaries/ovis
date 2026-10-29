### Maintenance
- The OpenCode Tab agent-switch integration tests now start from a closed autocomplete. The test
  before them left the skill row selected on screen, and a send that read that old screen could not
  tell the agent before Tab, which failed the tests now and then.
