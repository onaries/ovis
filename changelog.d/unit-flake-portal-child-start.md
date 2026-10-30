### Maintenance
- The two Portal unit tests that spawn an unrelated process (a shell, a Bun script) give it 20 s to
  print READY and to exit, instead of 2 s, which a loaded runner's Bun start exceeded.
