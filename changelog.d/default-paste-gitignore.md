### Fixed
- Pasted and attached files no longer show up in the project's Git status: the default
  `.ovis` folder now ignores itself, and its files still open by the path the prompt
  names. An ignore file already in that folder, or an `OVIS_PASTE_DIR` folder, is left as is.
