### Maintenance
- `HERDR_RPC_COUNT=1` counts the server's requests to herdr's socket API per method, event
  subscriptions included, and when the server exits cleanly writes the tally as one line on
  standard error, which a launcher or log capture may save. It is off unless set to exactly `1`,
  and the counts are not sent anywhere.
