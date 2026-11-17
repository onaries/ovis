### Fixed
- Markdown previews and chat messages read a link with a title (`[docs](https://x.dev "Docs")`)
  as a link, whose title shows when the pointer rests on it.

### Changed
- A Markdown link's text now ends at its first `]`: `[docs](https://x.dev/a](https://y.dev/b)` links
  `docs` to `https://x.dev/a](https://y.dev/b`, where it linked `docs](https://x.dev/a` to
  `https://y.dev/b`.
