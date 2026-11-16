### Fixed
- An Oh My Pi pane on macOS whose sessions moved to the XDG folders (`omp config init-xdg`) shows
  its chat again, as it already did on Linux.
- Resume lists Oh My Pi sessions from the folder Oh My Pi writes them to when `XDG_DATA_HOME`,
  `PI_CONFIG_DIR` or a profile moves it, not only from `~/.omp/agent/sessions`.
