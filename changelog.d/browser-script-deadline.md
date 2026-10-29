### Maintenance
- CI's parallel browser lane stops a script that runs past `BROWSER_SCRIPT_TIMEOUT_SECONDS`
  (600 s by default) with every process it started, and names it with its last log lines, so a
  hang fails fast instead of running into the job's timeout.
