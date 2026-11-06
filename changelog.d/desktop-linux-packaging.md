### Fixed
- Desktop app on Linux: menus and docks show the Ovis icon (the package now carries every size from
  16 to 512 pixels), and removing the .deb with sudo stops the terminal server the app started
  instead of leaving it running with nothing left to stop it.
- Desktop app: the tray and menu bar follow the system language (Korean, Japanese, Chinese), and
  Settings > About says in your language that updates come with the app.
- Desktop app: update messages go to the app's log, a .deb built without updates says so plainly,
  an AppImage run without FUSE no longer leaves about 400 MB in the temporary folder, and the
  package description no longer points at a source file.
