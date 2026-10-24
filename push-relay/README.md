# Push relay

The Cloudflare Worker that carries the PC's alerts to the Ovis phone app, at `push.ovis.sh`.
The app's web view gets no Web Push, so the relay stands in for a browser's push service: to the
PC's `server/push.ts` it is one more Web Push endpoint, and it hands each push to Apple's push
service (APNs) for the iOS app, or to Firebase Cloud Messaging (FCM) for the Android app. Why and how it fits the app: [docs/native-app.md](../docs/native-app.md#notifications).

Pushes are end-to-end encrypted. The PC encrypts each alert for keys the app made and keeps in
its keychain (RFC 8291), and the relay forwards the ciphertext as it came; it never holds a key
that could read it. The iOS app's Notification Service Extension decrypts it on the phone, and
the Android app's messaging service does the same.

## What it answers

`POST /v1/register` (the app), with `Content-Type: application/json`:

```json
{ "token": "<APNs device token, hex>", "environment": "production", "vapid_key": "<the PC's VAPID public key>" }
```

`vapid_key` is the `public_key` the PC's `GET /api/push` answers (base64url, an uncompressed
P-256 point), the key a browser would pass to `pushManager.subscribe` as its
`applicationServerKey`. `environment` is `production` (the default) or `sandbox`, for a token
from a development build. The Android app registers its FCM registration token instead,
`{ "service": "fcm", "token": "<FCM registration token>", "vapid_key": "..." }`; a relay without
FCM credentials (`FCM_SERVICE_ACCOUNT`, below) answers that with `501`. The answer is `201` with
`{ "endpoint": "https://push.ovis.sh/v1/push/<id>" }`, where `<id>` is random and stands for the
token: the token itself never leaves the relay.

- The endpoint is pinned to `vapid_key` from the start, as a browser's subscription is bound to
  its `applicationServerKey`: a push signed by any other key is refused, the first one included,
  so whoever learns an endpoint before the PC pushes to it cannot claim it.
- Every registration makes a new endpoint, one per PC. The app registers once per PC and keeps
  that endpoint (with the keys it made for it), rather than registering at every launch: a token
  keeps the 32 endpoints registered last, and registering a 33rd drops the oldest. An endpoint
  neither registered nor pushed to for 60 days is deleted by a daily cron; the PC's next push
  then gets `404` and drops the subscription, and the app registers again.
- Registrations are limited before anything is written, by Cloudflare's Rate Limiting bindings
  (`wrangler.toml`), whose counts are per Cloudflare location and approximate (a burst can pass a
  few more). Past either limit the answer is
  `429` with `Retry-After: 60`.
  - `REGISTER_LIMITER`: 10 a minute per address (`CF-Connecting-IP`). The address is the
    limiter's key only, and is not stored.
  - `REGISTER_GLOBAL_LIMITER`: 60 a minute from all addresses together, a backstop for many
    addresses at once. It is asked only once an address's own limit lets a registration through,
    so one address over its limit never uses up the cap every phone shares. One fixed key alone
    would let a single abuser block every phone's registration.

What registration does not do: it does not prove that the caller holds the token. Anyone who
knows a phone's device token can register endpoints for it with a key of their own, push to it
(the phone then shows "herdr needs you", which it cannot decrypt, within the limits below), and
by registering 32 of them drop the phone's real endpoints (each PC then gets `404` and the app
has to register again). A device token is known only to the phone, APNs and whoever the app gave
it to (this relay), so this needs a leaked token. Proving the app is genuine (App Attest) would
close it, and is not done.

`POST /v1/push/<id>` (the PC) is a Web Push request (RFC 8030): an `aes128gcm` body of at most
4096 bytes, a `TTL` header, optionally `Urgency` and `Topic`, and a VAPID `Authorization: vapid
t=..., k=...` header (RFC 8292) whose token names this relay's origin as its audience.

- A push signed by a key other than the endpoint's (`vapid_key` at registration) is refused
  (`403`), so knowing an endpoint is not enough to send to a phone. A missing, expired or forged
  token is `401`.
- An endpoint takes at most 60 pushes per 10 minutes, and a phone (a device token) at most 120
  across all its endpoints, so registering more endpoints buys no more pushes. Past either the
  answer is `429` with `Retry-After` until the window ends. A refused push does not count.
- The push goes to APNs as a `mutable-content` alert:
  `{"aps":{"alert":{"body":"herdr needs you"},"mutable-content":1},"ovis":"<ciphertext, base64>"}`.
  The extension replaces the alert with the decrypted title and body; the line in `aps` is what
  the phone shows when it cannot. `Urgency: high` becomes APNs priority 10 (any other, 5), `TTL`
  becomes `apns-expiration` (at most 28 days; `0` delivers now or never), and `Topic` becomes
  `apns-collapse-id`, so a newer push with the same topic replaces one still waiting.
- To an FCM token the push goes as an FCM HTTP v1 data message,
  `{"message":{"token":"...","data":{"ovis":"<ciphertext, base64>"},"android":{...}}}`, with no
  notification part: Android hands it to the app, which decrypts it and shows the PC's title and
  body (or "herdr needs you" when it cannot). `Urgency: high` becomes FCM priority `HIGH` (any
  other, `NORMAL`), `TTL` becomes `android.ttl`, and `Topic` becomes `android.collapse_key`. The
  relay signs in with the service account (Google's OAuth JWT flow) and reuses the access token
  for 50 minutes; FCM refusing it makes the relay get a new one and send the push once more.
- The answer is `201` once APNs or FCM takes the push. APNs saying the token is gone (`410`, or
  `400` with `BadDeviceToken` or `DeviceTokenNotForTopic`), or FCM saying so (`UNREGISTERED`,
  `SENDER_ID_MISMATCH`, or `INVALID_ARGUMENT` naming no field but `message.token`, its answer to a
  token that is not one), deletes that token's endpoints for the same service (for APNs, the same
  environment) and answers `410`, which the PC takes as an unsubscribe; an unknown endpoint is
  `404`, which it takes the same way (another PC's next push to the token's endpoints gets it).
  Endpoints of the token in the other APNs environment, or for the other service, stay: APNs
  answers `BadDeviceToken` to a production token sent to the sandbox, so a leaked token registered
  once as the other environment cannot wipe the phone's real endpoints. APNs refusing the
  relay's provider token as expired or invalid makes the relay sign a new one and send the push
  once more. A
  body that no longer fits APNs' 4 KB once base64-encoded is `413`, a content encoding other than
  `aes128gcm` is `415`, APNs or FCM throttling is `429`, and any other failure is `502`.

## What it keeps

One D1 table (`schema.sql`), one row per endpoint: the random ID, the device token, its service
(APNs or FCM) and, for APNs, its environment, the pinned VAPID public key, when it was registered and last pushed to (for the
32-endpoint cap and the 60-day expiry), and the start and count of the current rate window.
Nothing of what a push said, and no address: the Worker reads the sender's address only as the
key of the registration limiter, which Cloudflare keeps for that minute's count and the Worker
never stores, and no header beyond those above. Workers Logs are off (`wrangler.toml`), so no
request log keeps the address either.

## Deploy

The relay needs the `ovis.sh` zone on the Cloudflare account it deploys to (the route in
`wrangler.toml` makes `push.ovis.sh` a custom domain of the Worker), and an APNs auth key
(a `.p8` file) from the Apple developer account that owns `sh.ovis.app`; for Android, a service
account key of the app's Firebase project ([app/android/ovis-push](../app/android/ovis-push/README.md)).
Create the database and apply the schema once:

```sh
cd push-relay
bunx wrangler login
bunx wrangler d1 create ovis-push-relay   # then put its database_id in wrangler.toml and commit it
bunx wrangler d1 execute ovis-push-relay --remote --file schema.sql
```

The APNs and FCM credentials are Worker secrets, never files in the repository:

| Secret | Value |
|---|---|
| `APNS_KEY` | the whole `.p8` file, `-----BEGIN PRIVATE KEY-----` lines included |
| `APNS_KEY_ID` | the key's ID, as Apple's developer site shows it |
| `APNS_TEAM_ID` | the ID of the team the key belongs to |
| `FCM_SERVICE_ACCOUNT` | for Android: the whole JSON key of a service account of the app's Firebase project (Firebase console > Project settings > Service accounts > Generate new private key); without it the relay takes no FCM token |

```sh
bunx wrangler secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8
bunx wrangler secret put APNS_KEY_ID
bunx wrangler secret put APNS_TEAM_ID
bunx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json   # then delete the file
bunx wrangler deploy
```

`APNS_TOPIC` in `wrangler.toml` is the app's bundle ID (`sh.ovis.app`). One key pushes to both
APNs environments; a registration says which one its token belongs to. The deploy also sets up
the daily cron (`[triggers]`) and the registration limiter (`[[ratelimits]]`); `namespace_id` only
has to be unique among the account's rate limiters.

Then send one real push before anything relies on the relay. The tests use a fake APNs, and APNs
takes HTTP/2 only, so only a real one shows that the Worker's requests reach it. With the device
token of an iPhone that has the app (a development build's token is a `sandbox` one):

```sh
bun push-relay/test-push.ts <device token> sandbox
```

It registers the token with a throwaway VAPID key and sends one push as `server/push.ts` would.
`push: 201` means APNs took it, and the phone shows "herdr needs you" (it cannot decrypt a push
made with throwaway keys). Anything else is APNs' or the relay's answer to look into.

For Android, the same through FCM, with the FCM registration token of a phone that has the app:

```sh
bun push-relay/test-push.ts fcm <FCM registration token>
```

The tests use a fake Google too, so only this shows that the relay signs in with
`FCM_SERVICE_ACCOUNT` and that FCM takes its message. `push: 201` means FCM took it. A made-up
token (any 32 letters) checks the sign-in without a phone: FCM calls it invalid, and the relay
answers `410` only once Google took its sign-in. Anything else is Google's, FCM's or the relay's
answer to look into.

## Running your own

The relay is open so anyone can run one: change `name`, the route and `APNS_TOPIC` in
`wrangler.toml` to your own domain and app, and follow the steps above with your own Cloudflare
and Apple accounts (and Firebase project, for Android). Endpoints name the origin the registration came to, so they follow the
domain without a code change.

## Tests

`bun test ./push-relay` from the repository root. The tests sign and encrypt pushes with
`web-push`, as `server/push.ts` does, and run the Worker over a real SQLite table built from
`schema.sql`, a fake registration limiter, a fake APNs, and a fake FCM with Google's token
endpoint (`test-push.ts` above is the check against the real APNs and FCM). In CI they run with
the unit tests in Fast checks (`scripts/ci-tests.ts`), as does the typecheck.
