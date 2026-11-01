### Added
- **Settings → Phone & devices → Portal** can put Portal's own sign-in in front of the address: a
  private link, an Ethereum wallet, or Google or company login (OpenID Connect), each with the
  names, wallets or accounts it lets in. Whoever gets through may watch by default, with no access
  token asked. Invitations keep a watch role on the server; the owner's app token still drives
  and paired devices keep their roles. Devices says who signed in. A visitor let in this way cannot
  pair or revoke devices, subscribe to push alerts or control Portal, and a page of theirs left
  open loses access within 5 minutes of the link expiring or a sign-out. A private-link Portal
  offers **Invite someone**: a link for 1, 7, 30 or 90 days, shown once. The app believes who
  Portal signed in only with a proof it hands that Portal in its environment, so other ways to
  the app's port cannot pass for it. A sign-in needs Portal v2.7.0 or later, which lists
  `--auth-identity-proof` and the OIDC flags; the panel says plainly when the installed `portal`
  does not. Google or company login reads its client secret from
  `OVIS_PORTAL_OIDC_CLIENT_SECRET`. The default, the access token or a paired device, is
  unchanged.
- A browser that Portal's sign-in let in can sign out from **Settings → Devices**. One click ends
  both app and Portal sessions when both exist; it does not sign out of the identity provider.
  Google or company login shows both callback addresses to register, including the short host.
