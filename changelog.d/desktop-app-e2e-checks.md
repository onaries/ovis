### Maintenance
- The desktop app has end-to-end checks of a built app (`app/electron/scripts/e2e.ts`): first
  launch without herdr, terminals across quit and relaunch, the tray, a killed app and an update
  from a local feed, each in a temporary HOME.
