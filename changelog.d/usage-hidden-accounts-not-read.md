### Fixed
- Plan limits stop reading a provider's sign-ins (for GitHub Copilot, `gh auth token` for each
  account) once every account of it is hidden in Settings or removed from Ovis. Before, hiding only
  changed what was shown. Each provider is still looked up once when the server starts or after a
  sign-in, so a new account is found; show one of its accounts again to find accounts added since.
