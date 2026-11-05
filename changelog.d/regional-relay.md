### Added
- Regional relay endpoints: a PC that uses the Ovis relay measures a regional relay (first
  `relay-ap.ovis.sh`, in Seoul) against `relay.ovis.sh` and, when it answers in at most half the
  time, also connects to it and puts it in new pairing QR codes, so phones nearby connect with far
  fewer slow round trips. The PC stays on `relay.ovis.sh` too, so phones paired before keep working,
  and a phone that cannot get through a regional relay tries `relay.ovis.sh` at once.
