### Fixed
- A command sent from Chat to a pi session larger than 16 MiB shows its result once pi records it,
  instead of staying "Accepted" until "No result seen" while pi kept writing to the session.
- A command sent from Chat to an OmO pane whose program Chat cannot find (native Windows) keeps its
  row once OmO's session starts, instead of disappearing with it.
- While a command sent from Chat waits for its result, each Chat refresh asks herdr for the pane's
  processes and sessions once instead of up to four times, and checking a long agent transcript that
  grew since the last refresh takes about a third of the time.
