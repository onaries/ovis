### Fixed
- A bare name in a Chat code span that nothing on the pane's PC has, such as a systemd unit
  (`user-1000.slice`) or a host, reads as plain code instead of a file link that could only open
  "No readable file at this path". A file of that name, several of them, or a folder keeps the link.
