### Fixed
- An installed agent that does not start (a wrapper whose target was removed, for example) is no
  longer shown with a version read from its error message: the agent catalog marks it as not
  running, and the setup card does not call it ready.
- The agent catalog runs a version check with the PATH the agent was found on, so an agent run by
  an interpreter only the login shell knows (nvm's Node, for one) is not taken for broken.
