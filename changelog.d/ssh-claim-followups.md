### Fixed
- The SSH list weighs Match blocks as ssh does (`host`, `originalhost`, `user`, `localuser`, `all`),
  and a host whose HostName depends on a condition it cannot weigh offline, such as `exec`, no
  longer claims a Tailscale PC. Neither does a host reached through ProxyJump or ProxyCommand.
  The list also follows the final pass a `Match final` line asks for, claims nothing once
  CanonicalizeHostname may change the name, and shows the User ssh would take first.
- The SSH list leaves out a host named in an included file when the Include sits in a block that
  does not apply to that host, as ssh does. A host from an Include under a condition it cannot weigh
  offline is listed without claiming a PC, and so is any host an included file left unread (too
  deep, too many files, or outside the home folder) could change.
- A changed hosts file or DNS answer counts the next time the SSH list opens, and the list's name
  lookups never pile up past 16 while a resolver hangs.
- An Include with a wildcard now reads a linked file (a dotfiles repo) as ssh does, when the file it
  links to is in the home folder. A link that leads outside it leaves the hosts it could change
  without a claimed PC.
- The SSH list reads ProxyCommand and ProxyJump, quoted `Match exec` commands and `Match final`
  as ssh does. It claims no PC for a host that an Include with a `%` token or `${VAR}`, a
  CanonicalizeHostname, or an Include wildcard matching more files than it reads could change.
- A long Host pattern in the ssh config, or one Host alias repeated thousands of times, no longer
  stalls the server while the SSH list is read.
