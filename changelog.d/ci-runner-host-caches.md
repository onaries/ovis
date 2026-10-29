### Maintenance
- Self-hosted CI runners keep a git mirror and the default branch's Bun packages on the host, read-only
  to jobs, so a job no longer downloads about 150-200 MB of checkout, tags and packages.
