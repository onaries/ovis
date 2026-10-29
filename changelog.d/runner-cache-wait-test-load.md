### Maintenance
- The self-hosted runner launcher's tests of a hung first cache refresh no longer fail on a loaded
  host: they wait for the refresh to hang through a FIFO the stub writes to (no polling), allow
  30 s for that and for the launcher to end instead of Bun's 5 s test timeout, and let no runner
  start before the refresh has hung; only the stop on SIGTERM keeps a tight bound (4 s) (#2261).
