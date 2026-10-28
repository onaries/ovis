### Fixed
- The installer no longer links the Node it installs into `~/.local/bin`, where it went before the
  Node of your own projects. Once Ovis runs this release, running the installer again removes a link
  it made earlier and says so: if that link was the only `node` your shells had, install your own
  Node to keep using `node` outside Ovis.
  Terminals that run on the Node fallback, and updates from Settings, use the right runtime even
  when herdr's PATH starts with an older Node (reported by @wafe).
