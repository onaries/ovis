# Security

Ovis gives a browser the terminals of the PC it runs on. Anyone who gets past its access
check can type into them, so a flaw in who gets in is as serious as it gets here.

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/devswha/ovis/security/advisories/new).
Do not open a public issue, pull request or discussion about it.

Include what you can of:

- the version (Settings, under Updates, opens with `Running vX.Y.Z (commit)`) and, for a remote PC, its OS;
- how the server was reached (localhost, SSH tunnel, `tailscale serve`, LAN, reverse proxy) and how
  the client signed in (this PC, Tailscale login, paired device, token, Portal's own sign-in);
- the steps to reproduce, and what an attacker needs beforehand;
- the impact, with evidence from your own setup. Leave out real tokens, pairing codes and cookies.

This is a project with one maintainer, so there is no guaranteed response time. Fixes ship as a new
patch release with a GitHub security advisory, crediting you unless you prefer otherwise. Please keep
the details private until that release is out.

## Supported versions

Only the latest `vX.Y.Z` release gets fixes. Installs update to it from **Settings → About** (or
by themselves with `OVIS_AUTO_UPDATE=1`). A fix in the remote-PC runtime ships as a new
`remote-vN` bundle together with the release that uses it.

## Scope

In scope, for example:

- getting in without a matching token, a paired device, the PC's own Tailscale login, a local
  connection or a visitor Portal's own sign-in vouches for with its proof (`server/access.ts`,
  `server/auth.ts`, `server/portal.ts`), including through a proxy or forged headers; and a visitor
  Portal let in using the app's own controls to leave access behind, such as pairing a device,
  subscribing to push alerts or issuing a link; a watch-only Portal visitor that can type, send
  keys, resize, read files or perform a write action is also in scope;
- pairing codes, device cookies and revocation (`server/devices.ts`); a revoked or observe-only
  device that can still type, send keys or resize;
- reading files, transcripts or screens outside what the app shows a signed-in client;
- script injection in the web client (chat Markdown, file viewer, prompt cards, push payloads);
- the remote-PC path: SSH, the bridge bundle's checksums and the relay (`server/ssh.ts`,
  `server/remote-bundle.ts`, `server/machine-api.ts`, `server/machine-relay.ts`);
- updates installing anything other than a published release (`server/updater.ts`,
  `server/supervisor.ts`, `install.sh`);
- sign-ins the subscription usage strip reads (`server/usage.ts`) leaving the server's PC other than
  to their own provider;
- push keys and subscriptions (`server/push.ts`).

Out of scope, as documented in [Access and safety](docs/guide.md#access-and-safety):

- getting into a server that is still ungated by design: bound off loopback or behind a proxy, with
  no token set and no device ever paired, and not behind a proxy on a PC whose Tailscale login is
  known. It is open to anyone who reaches it, and the server warns about it on startup. Getting past
  the gate once a token is set or a device is paired is in scope;
- anything reached through `tailscale funnel`, which is unsupported;
- people you gave drive access to (a driving paired device, the token, your tailnet login, or an
  explicitly elevated Portal invitation) using it, including through a terminal: reading the
  server's environment or state files, or keeping a way in after their access ends;
- vulnerabilities in herdr, the agents, Tailscale or the browser themselves: report those upstream.

Test only on PCs and accounts you own.
