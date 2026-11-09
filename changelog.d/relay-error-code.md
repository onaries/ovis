### Added
- `GET /api/relay` reports why the relay is not online as a fixed `error_code` (such as
  `relay_unreachable` or `pass_required`), beside the `error` sentence, so an app can say it in its
  own words and tell whether the PC tries again by itself.
