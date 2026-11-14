### Changed
- The one-line installers (install.sh, install.ps1) and the herdr plugin now install the release's
  compiled server and built client instead of building the sources with Bun. Each download is used
  only after the release's manifest verifies against the signing key pinned in the repository and
  every file matches its size and SHA-256; a failed check leaves the installed version untouched.
  The `ovis` command runs that binary and needs no Bun.
