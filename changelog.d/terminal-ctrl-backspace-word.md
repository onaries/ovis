### Fixed
- Ctrl+Backspace in the terminal deletes the word before the cursor instead of one character: it
  sends Ctrl+W, in every program (in vim or nano Ctrl+W keeps its own meaning there). Input held
  after a disconnect drops that word too. A pane drawn as a mirror (a Windows PC's) keeps Ctrl+H,
  which Windows shells already read as the word erase.
