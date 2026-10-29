### Maintenance
- The terminal arrows and clicks browser check no longer fails now and then on a busy CI runner.
  It reads each letter before pressing the arrow that follows it, waits for xterm to report the
  mouse before clicking, and proves that nothing arrives by typing a mark instead of waiting a set
  time. A new unit test checks that the server holds an arrow back after the typing before it.
