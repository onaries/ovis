### Added
- Chat draws math written with dollar signs: `$…$` inline, `$$…$$` and a ```math fence as display
  math, beside `\(…\)` and `\[…\]`. A dollar sign reads as math only where a price or a shell
  variable cannot: after no Latin letter or digit, with no space inside its ends, on one line,
  before no Latin letter, digit or shell mark (`{ ( # @ *`), and not a number followed by a word,
  so "$5 and $10", `$HOME/${PATH}` and `$(whoami)` stay as written while `$x$는` and
  `$2 + 2 = 4$` are drawn. A formula KaTeX cannot draw shows as written.
