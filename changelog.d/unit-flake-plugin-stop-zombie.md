### Maintenance
- The plugin start test counts a stopped server that has exited but is not yet reaped as gone, as
  `stop` itself does, instead of failing while signal 0 still reaches it.
