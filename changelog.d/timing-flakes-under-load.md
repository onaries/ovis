### Maintenance
- Three tests that failed on busy hosts with nothing wrong in the code now measure what the code
  controls: the browser lane's stubbed runs get a 60 s hang guard, which ends the lane's process
  tree and fails with what it printed, instead of a 5 s limit (#2110); the Codex matcher's
  bounded-time cases compare the CPU time of an input with that of one as long that the code
  reads in one pass, which leaves the work both share out of the ratio while each still fails the
  quadratic scan it guards (#2142); and the OpenCode first-key gap is measured from the last thing that send itself
  waited on (#2143).
