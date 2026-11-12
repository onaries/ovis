### Added
- Plan limits also show a Claude account you use only through Gajae Code, from the last report Gajae
  Code keeps of it (for a day), never from its sign-in. It is marked **Recorded by Gajae Code** with
  how long ago, as an account recorded by Oh My Pi is.

### Fixed
- A recorded limit no longer passes for a current one while the server cannot be reached: the page
  judges the record's own age, so it dims and says it may have changed after 15 minutes, and the
  composer stops showing it.
- A tool's record is found where `PI_CONFIG_DIR` (Oh My Pi) or `GJC_CONFIG_DIR` (Gajae Code) gives its
  folder another name than `.omp` or `.gjc`.
