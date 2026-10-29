### Fixed
- An omp started from its npm package (bunx or npx run `dist/cli.js` with bun) shows its approval
  card in Chat again; the card stayed hidden and the answer had to be given in the terminal (#2280).
- An omp Ask question with a Mermaid diagram, or with options that would read alike on the card,
  shows as omp draws it, so the card never shows a diagram in place of the code or two identical
  rows (#2233).
- A prompt card's typed answer no longer picks one of two rows that look alike across scripts
  (Cyrillic `о` beside Latin `o`), and a typed row number picks its row even when its name looks
  like another row's. Commas or spaces alone on a multiple choice are the typed text, not an empty
  answer (#2233).

### Maintenance
- The Unicode case folding and confusables tables are generated only from source files whose SHA-256
  matches the pinned one (#2233).
