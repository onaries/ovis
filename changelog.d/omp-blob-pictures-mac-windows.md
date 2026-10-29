### Fixed
- Chat shows omp's pictures from its blob store on macOS and Windows too, not only on Linux: the
  bridge opens a blob through the store directory it holds open, so a link or a directory swapped
  in above it can never stand in for the store.
