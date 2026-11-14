### Fixed
- The chat's Stop now stops Grok, Devin, Kilo and maki. Grok cancels on Ctrl+C, which Stop now
  sends while Grok shows a turn to cancel. Devin, Kilo and maki take Escape twice. One Escape did
  nothing there, or moved Devin's running command to a background shell.
