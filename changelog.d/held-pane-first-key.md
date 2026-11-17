### Fixed
- A terminal tab that waited while another app had its pane open no longer loses, without a word,
  the keys typed as it takes the pane back, before its screen is drawn again: they reach the pane
  once it takes input, and until then are refused with a notice, as a password typed then would be.
