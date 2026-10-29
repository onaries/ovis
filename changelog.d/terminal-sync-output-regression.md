### Maintenance
- The browser lane follows synchronized output (`CSI ? 2026 h` … `l`) from a real pane to the
  rendered rows: the bridge passes herdr's frames intact, herdr holds a pane's frame until it
  closes, and the run counts the renders xterm 5.5 draws from half a frame (#1617).
