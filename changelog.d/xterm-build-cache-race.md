### Maintenance
- Builds running at once in one checkout, like the browser lane's parallel workers, no longer fail
  now and then with a missing xterm export: xterm's source is built once into its own cache
  directory and never rewritten while another build reads it.
