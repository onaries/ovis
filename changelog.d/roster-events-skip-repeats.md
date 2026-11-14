### Fixed
- A PC reached through the relay no longer resends its whole roster every few seconds when nothing
  changed: a roster identical to the event just sent is skipped, so on a slow connection the chat or
  terminal being opened is no longer stuck behind repeated copies of the agent list.
