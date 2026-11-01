### Fixed
- On the Node PTY host, a terminal whose command exits while its output is paused or still being
  sent keeps that last output: the host now holds the pty until it has read everything, as the Rust
  PTY host does, instead of dropping what was left after 200 ms.
