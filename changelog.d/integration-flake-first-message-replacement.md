### Maintenance
- The integration test that holds a first message once a same-kind agent replaces its own now starts
  the replacement before the first agent ends. Before, the shell alone was in front between the two,
  and a read in that gap rightly found the launched agent gone, which failed the test now and then.
