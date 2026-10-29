### Maintenance
- The file-thread test that holds a thread inside a read can no longer hang the unit run: its
  stand-in thread opens the FIFO it waits on before saying it is reading, and the test releases it
  with a write that never waits, so a thread ended in between no longer blocks the test forever.
