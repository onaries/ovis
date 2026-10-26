### Added
- A device whose push alerts stopped is told why: when the push service retired its subscription,
  the server no longer knows it or it was made for another server key, one line over the pane and
  the Test notification row of Settings → Alerts say so and offer Turn alerts on again, which
  subscribes the device anew; a refusal is told and opens Alerts, where Send test answers it. The
  server keeps the outcome of the last push to each subscription (`push-delivery.json`, owner-only,
  bounded like the retired list) and answers `POST /api/push/status` to the subscription's owner
  holding its keys alone. A failure older than the last success, no answer, throttling or a server
  error never raises the line, and no probe push is sent to find out.
