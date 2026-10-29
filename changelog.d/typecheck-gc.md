### Maintenance
- Native TypeScript checks use less CPU with `GOGC=400` and at most 32 Go scheduler threads,
  retaining GC for concurrent CI runners. Caller `GOGC`, `GOMAXPROCS`, and `GOMEMLIMIT`
  settings are preserved.
