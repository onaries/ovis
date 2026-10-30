### Maintenance
- The Codex process tests read their fixtures' whole READY line, which a busy pipe can hand over in
  two pieces, instead of taking the first read for the line.
