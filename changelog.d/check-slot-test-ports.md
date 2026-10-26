### Maintenance
- The check slot tests take their lock ports below 32768, under the ports Linux, macOS and Windows
  hand out on their own by default, so a neighbouring test's server can no longer take a ticket
  port and shift the queue; the ticket desk wait is measured on a clock of the test's own instead
  of the host's speed.
