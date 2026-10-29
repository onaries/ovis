### Maintenance
- The browser check that a focused window takes its pane back no longer times out waiting for a
  resize after the first attach: since a new terminal attaches once its font is set, that attach
  already carries the final grid, so the check now waits for the shell to report the grid each
  window last asked for, by attach or by resize.
