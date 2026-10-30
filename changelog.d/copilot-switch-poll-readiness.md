### Maintenance
- The Copilot integration tests wait for a transcript answer through a switch's in-between replies
  (scrollback, or a 409 when ownership changes mid-read) instead of reading every reply as one,
  and print each reply they wait past.
