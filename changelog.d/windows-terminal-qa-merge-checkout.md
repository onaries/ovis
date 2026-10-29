### Maintenance
- The native Windows terminal check now tests a pull request's merge with main, as the other CI
  checks do. On a branch cut before the check's script was fixed, it ran that branch's old script
  and timed out after the wheel pan, which made the check look flaky.
