### Fixed
- With `OVIS_RUNTIME=herdr-core`, tapping key-bar keys no longer types the terminal's own colour,
  focus and device answers (`^[[I`, `]10;rgb:…`) into the program when they arrive while a key is
  still on its way.
