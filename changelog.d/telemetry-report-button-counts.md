### Maintenance
- `scripts/telemetry-report.ts` reads the button counts too: per width, the share of installs that
  used each counter (with the installs it is a share of) and the middle install's typical day, each
  install counted once (never a mean), the controls shown, chat/terminal switches by kind of agent
  and by version, and `--html` writes the report as one page.
