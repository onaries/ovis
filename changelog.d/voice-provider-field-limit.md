### Fixed
- Voice input no longer fails in a pane with many slash commands when the transcription server
  caps a request at 32 fields (codex-lb does): only as many command hints are sent as fit.
