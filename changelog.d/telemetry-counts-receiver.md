### Maintenance
- The telemetry receiver can take a finished day's button counts (`POST /v1/counts`) into a new
  `counts` table, up to 14 days late, dropping any counter name it does not know while keeping the
  rest. No app sends them yet, and the notice and what the app says it sends are unchanged.
