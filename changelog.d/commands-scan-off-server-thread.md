### Fixed
- Listing a pane's slash commands no longer stops the whole server while its skill and command
  folders sit on a slow filesystem (a Windows folder mounted into a container, a network share):
  the scan runs on the file threads, so terminals, typed input and other requests keep answering
  while it reads. Thanks to @PayrollFuchs for the report and the measurements (#2254).
