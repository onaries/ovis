### Added
- Relays and PCs accept a second relay pass form that can say whether new client sessions to the
  PC are allowed; the relay does not act on it yet. A PC now tells the account service which pass
  forms it reads, and shows `new_sessions: false` in the pass part of `GET /api/relay` while the
  relay says its pass holds and the pass says so.
