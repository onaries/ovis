### Maintenance
- The output contract tests for a terminal attach that cannot spawn now make the spawn fail on the
  Rust PTY host too, so they pass in a checkout with the Rust host built, not only with the Node
  sidecar. Thanks to @kilhyeonjun for the report and the diagnosis (#2344).
