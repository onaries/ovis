### Maintenance
- A local browser lane run (no `CHECK_DIR`, no CI) takes the empty evidence folder it hands each
  check as none in every check: the touch-burst and terminal-autoswitch checks no longer write
  their captures into the checkout, and with `BROWSER_PARALLEL=1` the question-wheel, CJK
  punctuation and late-faces checks no longer fail at once creating an empty path (#1554).
