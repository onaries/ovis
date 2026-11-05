### Changed
- Reduce roster and health reads to a 30-second backstop while the event stream is open and its
  latest roster shows this PC connected. A lost stream, this PC going away (pushed or read), a
  failed health check, or a locked tab restores five-second checks; background tabs still poll
  nothing.
