### Fixed
- After a restart of the Ovis server or a lost connection to a PC, browser tabs no longer retry
  their connection in lockstep: from the 4 s step of the reconnect backoff on, each tab's delay is
  jittered. The shorter first steps stay as they were, so a short restart still goes unnoticed.
