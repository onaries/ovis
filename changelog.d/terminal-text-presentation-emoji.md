### Fixed
- An emoji followed by the text-presentation selector (U+FE0E, as in `⚽︎`) takes one cell in the
  terminal, as herdr and herdr-core lay it out, so the text, cursor and selection after it no
  longer sit one column to the right.
