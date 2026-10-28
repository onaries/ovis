### Maintenance
- The unit test run (`bun run test:unit`, CI's Fast checks) now also runs the component tests
  named `*.test.tsx`, which it had never picked up, and the agent sidebar's test passes when it
  runs on its own.
