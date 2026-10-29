### Fixed
- The sidebar no longer goes stale for about three seconds when many agents change status at
  once. A burst of more than five status changes closed the browser's event stream, which then
  reconnected and read the whole roster again, and a finish in between rang no sound and showed
  no drop-in on the page. The stream now lets a browser fall up to 4 MiB behind, beside the one
  large roster it may be reading, before ending it, and every browser's stream together holds at
  most 32 MiB for those that fell behind, so stalled devices can no longer fill the server's memory.

### Maintenance
- `scripts/roster-bench.ts` measures what a status burst costs the server and the browser with
  20 to 300 agent panes in an isolated herdr (#772).
