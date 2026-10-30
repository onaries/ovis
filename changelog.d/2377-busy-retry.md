### Fixed
- Pi's Earlier sessions list retries a busy reader automatically and offers Retry if it stays busy,
  rather than showing an error or an empty list. A bounded metadata cache avoids rereading
  unchanged transcripts while picking up new prompts and renamed or cleared session names.
