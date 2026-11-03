### Fixed
- Stop repeatedly asking to reload when a restarted source server still serves the browser build
  already loaded in the tab. Real client updates, server restart requirements and failed chunks
  retain their existing recovery controls.
