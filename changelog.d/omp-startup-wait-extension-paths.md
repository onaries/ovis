### Fixed
- Chat messages sent to a starting omp now also wait for herdr's integration when omp loads it
  from the project's `.omp/extensions`, an `-e`/`--extension`/`--hook` file, or the agent directory
  `PI_CODING_AGENT_DIR`, `PI_PROFILE` or `PI_CONFIG_DIR` names. An omp started with
  `--no-extensions` or `--trusted-extension` is sent to at once instead of after 30 seconds, and a
  wait that runs out without a report is now noted in the server log.
