### Fixed
- Powerline separators in a prompt no longer make the terminal redraw every row when the icon font
  arrives: they are painted as boxes, not drawn from the font. A pane that prints icons still
  redraws once their font arrives, so they are sized from it.
