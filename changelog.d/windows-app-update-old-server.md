### Fixed
- Ovis for Windows no longer offers Start for an Ovis server older than the app, or one installed
  under the old `devswha.herdr-web-ui` id: it shows Update, which updates it in place (herdr, Bun,
  settings and token stay), starts it, sets herdr to start at sign-in and ends at the phone's QR
  code. It says so when it cannot read the server's version, and names a herdr that is too old.
  The plugin's `status` now prints the version that runs, which can be newer than herdr's list.
