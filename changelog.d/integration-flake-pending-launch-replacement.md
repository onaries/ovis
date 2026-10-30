### Maintenance
- The integration test for a launched agent replaced before its page attaches starts the replacement
  before the first agent ends, so no status read lands while the shell alone is in front and
  rightly finds the launch ended.
