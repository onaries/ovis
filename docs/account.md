# Linking devices with an account

Signing in to an account lets one approval add a device to every PC of that account, and one tap
remove a lost device from all of them. The account only finds PCs and carries messages: who gets
into a PC is still decided by that PC's own device list (`devices.json`), as with
[pairing through the relay](relay.md#who-gets-in). This page is the contract between the PC
(`server/account/`), the apps and the account service. The code is in
[`shared/account-records.ts`](../shared/account-records.ts); tests use the in-memory service in
[`shared/account-service-fake.ts`](../shared/account-service-fake.ts).

Nothing here changes how a device signs in: `AUTH` (`device-key`) and the mux frames stay as they
are ([Ovis Mux v1](relay.md#ovis-mux-v1)).

## Rules

1. **`devices.json` is the only authority.** The account service and the records it carries never
   admit a device by themselves. **Revoke** and **Revoke all** on the PC always work and always win.
2. **One account key per client.** A client (phone app, browser, the desktop app's view of other
   PCs) holds one ECDSA P-256 key for the account, made by WebCrypto as non-extractable and kept in
   its own IndexedDB database (`ovis-account`). On every PC of the account that key is the device's
   `relay_public_key`, and `AUTH` signs with it as with any device key.
3. **A PC holds no account key and signs nothing.** Only clients sign records. A coding agent that
   runs as the user on a PC therefore cannot add a device to the account's other PCs. The desktop
   app is both a PC and a client, so an agent on that machine could drive the app's key: that risk is
   known, and every admission is announced on every device so it shows.
4. **Records are signed one by one.** `add`, `remove` and `link` each carry their own signature;
   there is no chain, order or first record. A PC applies an `add` or `remove` only when its signer
   is a current account member with drive access in that PC's `devices.json`. A `link` needs no
   member: it comes over the linked row's own session, which is its authority.
5. **Removal is permanent until the PC says otherwise.** `remove` revokes the device and leaves a
   tombstone for its key. No account record clears a tombstone; only a pairing or revoke done on
   that PC does. A replayed `add` for a removed key is refused.
6. **A signer adds only keys it checked itself**, by comparing digits or from a QR code, never a key
   the account service handed it.
7. **The account service can hide records, never forge them.** It stores the PC directory
   (`server_id` and a name, no keys), a mailbox of signed records per PC, and admission requests.

## Account members

A row of `devices.json` is an **account member** when it has `account` set. Rows come to be members
in three ways:

- `add`: a record signed by a member inserts the row, with `account`, `added_by` (the signer's
  device id on this PC) and the role in the record.
- `link`: a device already paired with this PC through the relay (by QR, code or comparing digits)
  proves its account key over its own session, and its row takes the account key and `account` in
  one write. This is how a PC gets its first member, so it needs no member before it.
- `enroll`: a member hands a PC it just paired a batch of `add` records for the account's other
  clients. It is a batch of records, nothing more.

The row an `add` makes has a known id, so the new device can sign in without asking the PC first:
the first 16 hex digits of `SHA-256("ovis-account-device/1" || server_id || key)`, with `server_id`
as its 32 hex characters and `key` as the record's base64url text (`accountDeviceId` in
[`shared/account-records.ts`](../shared/account-records.ts)). `AUTH` is unchanged and signs with that
id. Rows made any other way keep random ids, and a device already on a PC keeps the id it has there
(an `add` for a key already present changes nothing): it knows that id from its pairing.

A PC belongs to at most one account: the account of its first member. A record for another account
is refused (`account_mismatch`). **Revoke all** clears the PC's account with its members; tombstones
stay.

Relay rows paired before the account existed and never linked (a PC that was off when the phone
moved its pairings over) are listed under `unlinked` in [`/api/account/status`](#pc-api) and shown
as "not covered by account removal". The client links them on its next connection. A browser paired
with a code on the PC's own address holds a cookie, not a key: it cannot be linked, stays outside
the account, and only **Revoke** on the PC removes it.

## Records

A record travels as JSON, with every field required and no other field allowed:

| field | `add` | `remove` | `link` | value |
|---|---|---|---|---|
| `v` | ✓ | ✓ | ✓ | `1` |
| `kind` | `add` | `remove` | `link` | |
| `account` | ✓ | ✓ | ✓ | the account's id: 1-64 of `A-Z a-z 0-9 _ -` |
| `key` | ✓ | ✓ | ✓ | the device's account key: P-256 SPKI, base64url without padding (91 bytes) |
| `label` | ✓ | | | the device's name, 1-48 characters, no control characters |
| `role` | ✓ | | | `drive` or `watch` |
| `server_id` | | | ✓ | the PC this link is for (32 lowercase hex) |
| `device_id` | | | ✓ | the row on that PC being linked (16 lowercase hex) |
| `old_key` | | | ✓ | that row's key before the link |
| `issued_at` | ✓ | ✓ | ✓ | when it was signed: ISO 8601 UTC with milliseconds (`toISOString()`) |
| `id` | ✓ | ✓ | ✓ | 16 random bytes, lowercase hex: the record's own id |
| `signer` | ✓ | ✓ | ✓ | the signer's account key, same encoding as `key` |
| `signature` | ✓ | ✓ | ✓ | ECDSA P-256 with SHA-256 over the signing bytes, IEEE P1363 (`r ‖ s`, 64 bytes), base64url |

A `link` is signed by the key it links to (`signer` equals `key`); an `add` is never signed by the
key it adds. A `remove` may be signed by the key it removes: that is how a device leaves the
account.

**Signing bytes.** The ASCII prefix `ovis-account/1`, then every field but `signature`, in the order
below, each as a 4-byte big-endian length followed by its UTF-8 bytes (`v` as the text `1`):

- `add`: `v kind account key label role issued_at id signer`
- `remove`: `v kind account key issued_at id signer`
- `link`: `v kind account key server_id device_id old_key issued_at id signer`

`AUTH` signs `ovis-relay-auth/1 ‖ nonce ‖ server_id` with the same kind of key. The two prefixes
differ at their sixth byte (`a` against `r`), so no record signature is a valid `AUTH` signature, and
no `AUTH` signature is a valid record. The digits' commitments and the server proof are hashes and
MACs, not signatures, so they cannot be confused with either.

**What a record cannot say.** An `add` names no PC: it is meant for every PC of the account, and a
PC that already has the key leaves its row as it is. A `link` names one PC and one row, so it is no
use on another. Nothing expires on `issued_at`; it only tells whether a `remove` was signed before this
PC itself paired the key again (`On the PC`), so a PC whose clock is minutes off can misjudge a
`remove` signed within those minutes.

## Who may admit a device

One rule for every way in: a pairing code, comparing digits, and joining through the account.

- **Approval on the PC itself:** a driving window opened directly on the PC (not a Portal visitor,
  not an open LAN window), or `bun scripts/plugin.ts pair --approve` in the PC's terminal, which
  shows the digits and asks y/n.
- **Remote approval:** a client connected through the relay with drive access whose row is an
  account member. It must **pick the new device's digits out of three** (two decoys the PC chose at
  random) before it can approve. A tap without looking picks right one time in three, and a wrong
  pick ends the request, so the person has to look again at a new comparison.
- On a PC that belongs to an account, a pairing code can be started only by the same people:
  directly on the PC (any window there with drive access, as before), or by a drive account member
  through the relay (`403 account_required` for any other relay device, `read_only` for a watch
  device). A PC in no account keeps letting any driving relay device start one, as before.
- **Every admission is announced** on every device connected to the PC: the new device's name and who
  approved it.

`GET /api/relay/pairings` lists the waiting requests: with their `digits` on the PC itself, and with
`choices` (three sets of digits, no `digits`) for an account member through the relay, which also
hears of every change as `remote-pairings` on its event stream; each entry also carries `key`, the
new device's P-256 key from its `PAIR_REQUEST`, bound by the commitment and the digits. That member
answers with `POST /api/relay/pairing` `{ "id", "decision", "digits" }`; `digits` is required to
approve, and a wrong pick answers 409 `wrong_digits` and ends the request. An approval answers
`{ "ok": true, "device_id" }`: the id the new device's row takes once its person confirms too,
`accountDeviceId(server_id, key)`, as every row a comparison makes.


**Joining through the account (design 5.3).** A comparison is otherwise taken only while the owner
has the pairing window open on the PC (a link without a code asked for in the last 10 minutes,
[relay.md](relay.md#who-gets-in)). A comparison with `pair-intent-account` is also taken without
it, only when all of these hold:

1. the PC belongs to an account;
2. that account's mailbox, pulled with the PC's server proof, holds an admission at most 10 minutes
   old naming exactly the key of this `PAIR_REQUEST`: the account service has seen this device
   signed in to the same account;
3. the PC has at least one drive account member to approve it.

Such a comparison is shown only to the account's members through the relay (`remote-pairings`,
digits picked out of three, as always), never to the PC's own windows, and never approved by itself.
Anything else is refused before any prompt and not counted as a failed pairing. A PC takes at most 5
such joins a minute; refused requests do not count toward them. A request whose admission the PC has
not seen yet makes it pull its mailbox, at most once every 10 seconds, so a device that asks right
after posting its admission may be refused and asks again. The admissions the PC knows are kept per
account and relay identity, so they never carry over to another account or a new identity.

At most three requests wait for approval at once on a PC. A wrong pick ends that request and counts
as a failed pairing.

**Failed pairings are counted on two paths.** Pairing codes, and comparisons that ask to pair this
PC only, share the 20 failures in 10 minutes described under [Who gets in](relay.md#who-gets-in).
Comparisons that ask to join the account have their own 20, so a flood of account requests cannot
pause pairing by QR code or code.

## Negotiation

A client offers features in `HELLO`; a PC that supports them selects them in `WELCOME`, as with
`pair-sas`. An older PC selects none and the client says to update Ovis on that PC.

| feature | meaning |
|---|---|
| `account` | the PC has `/api/account/*` and applies records |
| `pair-intent-pc` | this comparison pairs this PC only |
| `pair-intent-account` | this comparison adds the device to the account |

A client offering `pair-sas` offers at most one intent; a PC selects an intent only together with
`pair-sas`, and only the one offered. A `HELLO` with both intents ends with `protocol_error`. A
comparison without a selected intent is `pair-intent-pc`.

The approval prompt says what is being approved: **pair this PC**, or **add to the account**; a
remote approver's app adds how many PCs that means from its own list of the account's PCs. The
intent travels inside the encrypted channel that the digits authenticate: a relay that changes it
must sit in the middle, and then the digits differ.

Either intent admits the device on this PC as a plain row. With `pair-intent-account` the new
device then links that row to the account itself (a `link` whose `old_key` is its `key`), and
the approver signs the `add` for it and delivers it to the account's other PCs. The intent decides
only what the prompt says and which failure count a comparison spends.

## PC API

All under `/api/account/`, JSON, `cache-control: no-store`. Every route needs drive access; through
the relay too. Mutations need the app's mutation guard, like the other routes.

`GET /api/account/status`

```json
{ "account": "acct_1" , "members": 3, "unlinked": ["6a1f0c9e2b7d4a10"], "removals": [<remove>, …], "mailbox": { "last_pull_at": "2026-11-05T01:02:03.000Z", "error": null } }
```

`account` is `null` before the first member. `unlinked` lists relay rows that are not members.
`removals` lists the signed `remove`s behind this PC's tombstones for its account, as received (a
Revoke on the PC has none). A client trusts none of them before it checks it (below).

`POST /api/account/link` `{ "record": <link> }`: the request's own device must be the record's
`device_id`, with `old_key` its current key, `server_id` this PC's. The row's key becomes `key` and it
becomes a member, in one write. `old_key` equal to `key` makes a row whose key already is the account
key a member. Answers `{ "device": <paired device> }`. The row's other sessions end (`auth_changed`):
they signed in with a key it no longer has. The linking session goes on, with no member's rights,
until it signs in again with the new key.

`POST /api/account/records` `{ "records": [<record>, …] }`: at most 32. Applies each in order and
answers every outcome, never failing the whole batch for one record:

```json
{ "results": [{ "id": "…", "outcome": "applied" }, { "id": "…", "outcome": "refused", "code": "tombstoned" }] }
```

Outcomes: `applied`, `unchanged` (an `add` for a key already present; a `remove` for a key already
removed and absent, or signed before this PC paired the key again) and `refused` with a code. A
`remove` for a key this PC never had still leaves its tombstone, so the key cannot be added later.
A `remove` refused `signer_not_member` waits on the PC with the mailbox's own such records
(`account-pending.json`) and applies once its signer becomes a member there.

`POST /api/account/enroll` `{ "account": "acct_1", "records": [<add>, …] }`: what a member sends a
PC it just paired. The request's own device must already be a member of `account` (it links itself
first). Same answer as `records`.

What a client keeps: on each connection to a PC of its account it reads that PC's `removals` and
keeps, verbatim, each one that verifies, is for its account and is signed by its own key or by a
device it approved itself (an `add` it signed), at most 256. A PC cannot make it keep a removal
signed by a key the PC made up, and it signs nothing for any of them.

What a client enrolls (`enrollPc` in [`src/lib/account/join.ts`](../src/lib/account/join.ts)): when
its link brings a PC that had no account into it, it sends that PC, over a session signed in with
the account key, the `remove`s it signed itself and the ones it kept, as signed (through
`records`), so the PC tombstones those keys, now or once their signer is a member there. It takes
no key from another PC's device list or status. It reads every record's outcome and sends again, on
its next connection to that PC, each one the PC did not answer or answered `account_unavailable`,
and any removal it signed while the enrollment ran.

It enrolls no `add`. No client can know it holds every removal of the account: one may sit in the
unread mailbox of a PC that is off, or only on PCs this client has no pairing with. An add it
signed earlier could then let a device another member removed into the new PC. So a new PC admits
the account's devices by approval instead: each device asks once and is compared digit by digit.

### Introductions

A device just admitted on PC X learns the account's other PCs from the member that approved it,
through X, and then signs in to each as usual; each PC still decides by its own `devices.json`.

`POST /api/account/introduce` `{ "key", "pcs": [{ "server_id", "server_public_key", "relay", "name" }] }`:
from a drive account member (`account_required` otherwise), for a key X holds a row for that an
account member added (`added_by`, from an `add` or a remote approval; `introduction_unknown_key`
otherwise). `pcs` lists only PCs the member verified itself (QR, digits, or its own pairing), at
most 32: `server_id` must derive from `server_public_key`, `relay` is a `wss:` origin, `name` at
most 48 characters (`introduction_invalid` otherwise). X keeps it in memory only, for 10 minutes;
a later one for the same key replaces it. Answers 204.

`GET /api/account/introduction`: over the new device's own signed-in session, watch access included
(the one account route that needs no drive access, since it reads only the caller's own
introduction); answers `{ "pcs" }` for its own key, or 404 `introduction_none`.

Known risk (T10 in the design): a compromised X can show the new device other PCs' keys than the
member sent. It already holds X's sessions; what it gains is the new device trying those keys. Each
PC then still admits it only by its own `devices.json`, and a PC the device has never been added to
refuses it.

The directory's `public_key` is stored but cannot be forged: it is bound to `server_id`, and a client
derives the `server_id` from it again before using it. Its `relay` is only a route; comparing digits
is what authenticates the PC.


## On the PC

- Membership lives on the rows of `devices.json` (`account`, `added_by`); the PC's account is the
  account of its members. Tombstones live beside it, in `account-tombstones.json` (readable by your
  user only), each with the signed `remove`s that made it, as received, one per signer (at most
  8). A tombstone file that will not parse is not an empty one: account records are then
  refused (`account_unavailable`) until it is restored, and so are a code started through the relay
  and a remote approval; the mailbox collects nothing meanwhile, so no removal is acknowledged
  unapplied. Pairing on the PC itself and signing in are unchanged. A **Revoke** meanwhile writes its
  tombstone to `account-tombstones.pending.json`, which the PC reads too and folds back in once the
  main file can be read again.
- An `add` whose key is not a P-256 point is refused (`record_invalid`): the signature covers only
  the signer, and devices.json accepts no such key.
- A code an account member started through the relay makes that member the new row's `added_by`,
  and lets nobody in once the member is revoked or demoted.
- A `remove` writes its tombstone before it revokes the device; the device's relay connections
  close at once (`auth_revoked`). A `remove` signed before this PC itself paired the key again leaves
  that pairing be (`unchanged`), so a late or replayed one cannot undo it. A row an `add` or a remote
  approval made goes, however late the `remove` arrives.
- **Revoke** and **Revoke all** on the PC leave a tombstone too, so no record brings the key back,
  even after the PC joins an account. An account `remove` for a key the PC revoked first takes over
  its tombstone.
- A pairing made on this PC (a code started on the PC, or a comparison approved here) clears that
  key's tombstone, after its row is written. A code started through the relay, or a comparison an
  account member approves remotely, is refused for a tombstoned key, except on a PC in no account:
  there a code started through the relay may let back a key the PC revoked itself (not one the
  account removed), and clears its tombstone.
- A stop between two such writes leaves a row and a tombstone for one key. On start the PC tells them
  apart by time: a row made before the key's removal is revoked, one made after it keeps its device
  and the tombstone goes. Until then no such row signs in, signs or approves.
- Where two state dirs share one device list, their tombstones are merged too.
- **Reset relay identity** removes every relay device, members included, so the PC leaves the
  account; a client adds it again by pairing with its new identity, after the client's usual "this
  PC's identity changed" notice.
- A record refused only because its signer is not a member yet (a `remove` that arrived before its
  signer's own `add`) is kept in `account-pending.json` and tried again on every pull, a restart
  included, until it applies; at most 1000 wait, the oldest dropped first.
- The PC collects its mailbox from `OVIS_ACCOUNT_SERVICE_URL` (https, or http on loopback only;
  `https://account.ovis.sh` when unset, none when `off`), only while it has members and a relay identity (one on disk counts, the relay on or off; none is ever made for it). An address
  it cannot use shows as the mailbox's error in `/api/account/status`.
- `/api/account/*` is refused to Portal visitors and open LAN windows (`owner_only`), and a `link`
  must start from the key its own session signed in with.
- Only a session that signed in with `AUTH` holds a proven key: one admitted with a code or by
  comparing digits sent its key but never signed with it, so it may not link, introduce or read an
  introduction until it signs in again. A member acts (approving, introducing, enrolling, starting a
  code) only from a session signed in with its row's current key.
- A code started through the relay records its starter as the new device's `added_by`, so the device
  counts as that starter's addition, not a pairing made on this PC.
- Every device that loses its access is announced on the machines event stream as
  `{ "type": "device-removed", "event_id", "device_id", "label", "removed_at", "by" }`, to streams with
  drive access only: `by` is `"pc"` for a revoke on the PC itself (Revoke all, a reset relay
  identity), the device that revoked it through the app, or the member that signed an account
  `remove`.
- `GET /api/devices` adds `account`, `account_key` (the member's `relay_public_key`, which is public)
  and `added_by` to account members' rows, for a caller with drive access only; a watching device
  sees none of them.

## Account service API

The service the apps and PCs call; a self-hosted install can point both at its own. Clients
authenticate with `Authorization: Bearer <access_token>` from [signing in](#signing-in); the PC never
signs in and proves its relay key instead. JSON bodies, errors as `{ "error": { "code", "message" } }`.

### Signing in

A sign-in only finds the account's PCs and rings its devices. It never admits a device anywhere:
that stays with each PC's `devices.json` ([Rules](#rules)).

OAuth's authorization code flow with PKCE, `S256` only:

1. `GET /v1/signin/{github|apple}?redirect_uri&state&code_challenge&code_challenge_method=S256[&response_mode]`
   sends the browser to the provider's sign-in, then back to `redirect_uri` with `code` and
   `state`: in the fragment (`#code=…&state=…`) for `https://app.ovis.sh/`, always, so the code never
   reaches that host's request logs; in the query for the loopback redirect, which a local server
   reads (a server never sees a fragment); and for `ovis://account/callback` in the query, or the
   fragment with `response_mode=fragment`. Any other pairing answers 400 `invalid_request`. The
   `code` is good once, for 60 seconds.
2. `POST /v1/token` `{ "grant_type": "authorization_code", "code", "code_verifier", "redirect_uri" }`
   answers `{ "access_token", "refresh_token", "expires_in", "account", "provider" }`.
   `redirect_uri` must be the one the code was issued for, and `code_verifier` the one whose SHA-256
   (base64url) was `code_challenge`.
3. `POST /v1/token` `{ "grant_type": "refresh_token", "refresh_token" }` answers the same. Refresh
   tokens rotate: each is good once, and using one again ends every token of its sign-in (its
   family), as a leaked one would be.
4. On iOS, Sign in with Apple hands the app an identity token directly:
   `POST /v1/token` `{ "grant_type": "apple_id_token", "id_token", "nonce" }` answers the same. The
   app makes a fresh random `nonce` of 16-128 characters for each sign-in, gives Apple its SHA-256 in
   lowercase hex, and sends the plain `nonce` here. The service accepts the token only when Apple's
   signature holds (Apple's published keys), `iss` is `https://appleid.apple.com`, `aud` is the
   app's id, it was issued at most 10 minutes ago and has not expired, and its `nonce` claim is that
   hash. Each nonce is accepted once.
5. A PC without a browser signs in with GitHub's device flow (RFC 8628):
   `POST /v1/signin/github/device` answers `{ "device_code", "user_code", "verification_uri",
   "expires_in", "interval" }`; the person opens `verification_uri` elsewhere and types `user_code`.
   The PC polls `POST /v1/token` `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
   "device_code" }` every `interval` seconds: 400 `authorization_pending` until the person approves,
   `slow_down` for a poll too soon (the interval grows by five seconds), `access_denied` if they
   refused, `expired_token` once it ran out; then the same answer as the other grants, once.
   A browser on a PC's own address signs in the same way, bound to a verifier: it starts with
   `{ "code_challenge", "code_challenge_method": "S256" }` (as in step 1, from 32 random bytes),
   the service answers with `"code_challenge_method": "S256"` added, and every poll carries
   `"code_verifier"`. A bound poll without that verifier, or with another, answers 400
   `invalid_grant` before GitHub is asked and without moving the interval, so the `device_code`
   alone redeems nothing. The page keeps the verifier in memory only, uses the service only when
   it named the method, links only to `https://github.com/login/device`, waits `Retry-After` on a
   429, and keeps no session from a sign-in cancelled meanwhile (it is stored under the same
   lock as a refresh or a sign-out).
6. `POST /v1/signout` (Bearer) answers 204 and ends that sign-in's family.

The client makes `state` (at least 128 bits) and `code_verifier` (32 random bytes, base64url) fresh
for each sign-in, keeps them with that sign-in only, and drops a callback whose `state` is missing or
not the one it sent.

`redirect_uri` is compared exactly against three forms: `https://app.ovis.sh/`,
`ovis://account/callback`, and `http://127.0.0.1:<port>/callback` on any port (a loopback redirect
for the desktop app, RFC 8252). Anything else answers 400 `invalid_redirect_uri` before any
sign-in. The hosted shell's Content-Security-Policy lets it reach `https://account.ovis.sh` (`connect-src`), and no other account service yet. The PC's own pages may reach `https://account.ovis.sh` when `OVIS_ACCOUNT_SERVICE_URL` is unset, exactly the origin it names when it is https with a host name or IPv4 address, and no account service when it is `off` or not https.

The desktop app offers sign-in in **Settings → Phone & devices** with `https://account.ovis.sh`
unless `OVIS_ACCOUNT_SERVICE_URL` names another https service. `OVIS_ACCOUNT_SERVICE_URL=off`
turns the account off for the app and its server alike: no sign-in, no account origin in the
pages' policy, no mailbox. A browser on the PC's own address cannot take a redirect (the service
sends a sign-in back only to the three above, none of which is that address), so it signs in
with GitHub's device flow (step 5), in the same place, with GitHub only: the PC writes
`<meta name="ovis-pc-account-service">` into its own shell with exactly the origin its policy
admits (none when the account is `off`), and the page offers the sign-in only on a secure page
(https, or `localhost`), where no one on the network could have rewritten the script that holds
the sign-in. The hosted shell keeps its redirect sign-in, and the desktop app its loopback one. Token errors are 400 `invalid_grant` (a wrong, spent or expired code, verifier, refresh
token or identity token) and 400 `unsupported_grant_type`; an access token that expired or was
signed out answers 401 `unauthorized` on every other request.

Clients:

| request | body | answer |
|---|---|---|
| `GET /v1/pcs` | | `{ "pcs": [{ "server_id", "label", "public_key", "relay", "added_at", "last_seen_at" }] }` |
| `PUT /v1/pcs/{server_id}` | `{ "label", "public_key", "relay" }` | `{ "pc": … }`: adds or renames a PC in the directory. 400 `server_key_mismatch` unless `public_key` (X25519, 64 hex) gives `server_id` (`deriveServerId`), 400 `invalid_relay` unless `relay` is a `wss:` origin |
| `DELETE /v1/pcs/{server_id}` | | `204` |
| `POST /v1/records` | `{ "server_ids": [...], "record" }` | `{ "queued": n }`: puts a signed record of the caller's account in that account's mailbox for each listed PC; the service checks only its shape and signature. 429 `mailbox_full` past 1000 records waiting for one PC |
| `GET /v1/admissions` | | `{ "admissions": [{ "key", "label", "server_id", "at" }] }`: this account's admissions of the last 10 minutes. Before it signs an `add` for a device a PC showed it, the approving client checks that PC and key are listed here |
| `POST /v1/admissions` | `{ "server_id", "label", "key" }` | `{ "id" }`: the signed-in device says it waits at that PC with its account key (`key`); rings the account's other clients (push), and reaches that PC's mailbox for 10 minutes |
| `POST /v1/signout` | | `204`: ends this sign-in's tokens |

Push (the doorbell), per signed-in device:

| request | body | answer |
|---|---|---|
| `GET /v1/push/key` | | `{ "public_key" }`: the VAPID key to subscribe with |
| `PUT /v1/push` | `{ "endpoint", "keys": { "p256dh", "auth" } }` | `204`: this device's subscription, one per signed-in device (a new one replaces it) |
| `DELETE /v1/push` | | `204` |

The service rings the account's other subscribed devices when a PC joins the directory and on
`POST /v1/admissions`. Every ring is the same payload,
`{ "pane_id": null, "title": "Ovis", "body": "Your Ovis account has news", "tag": "ovis-account" }`,
with nothing about which device or PC: the app asks its PCs.

Limits: an account lists at most 100 PCs (409 `directory_full`), rings for admissions 10 times
and makes 600 requests in 10 minutes (429 `too_many_admissions`, 429 `rate_limited`), and holds at
most 1000 records waiting for one PC (429 `mailbox_full`). A 429 carries `Retry-After`.

The PC, by server proof:

| request | body | answer |
|---|---|---|
| `POST /v1/pc/challenge` | `{ "server_id", "public_key" }` | `{ "challenge_id", "frame" }` |
| `POST /v1/pc/mailbox` | `{ "server_id", "challenge_id", "proof", "account", "ack" }` | `{ "records": [{ "seq", "record" }], "more", "admissions": [{ "key", "label", "at" }] }`: `admissions` lists that account's admissions for this PC made in the last 10 minutes, on every pull until they age out |

`public_key` is the PC's relay key (64 hex); the service refuses it unless it gives `server_id`
(`deriveServerId`). `frame` is a `server_challenge` (`serverChallenge` in
[`shared/relay-server-proof.ts`](../shared/relay-server-proof.ts)) for the route `{ server_id, role:
"account", connection_id: challenge_id }`; `proof` is the PC's `server_proof` answer for that same
route. A challenge is good for 60 seconds and one answer. Anyone can list any `server_id` in their
directory, so mailboxes are kept per PC **and account**: the PC asks only for its own account's
(`account`), and another account's records can neither fill nor hide them. `last_seen_at` moves
only in that account's directory. `ack` is the highest `seq` the PC processed, whatever the
outcome, refused included (or `null`); the service deletes those records before answering, and
deletes any record after 30 days. The PC pulls when it starts and every five minutes while it
belongs to an account.

The `account` role keeps the two proofs apart: the relay verifies `control` and `data` only, so an
answer the PC gave the account service is no use to the relay, and a relay's challenge passed on by
the account service gets an answer the relay refuses.

## Errors

| code | status | meaning |
|---|---|---|
| `account_required` | 403 | this needs a drive account member |
| `account_mismatch` | 409 | the record is for another account than this PC's |
| `record_invalid` | 400 | a record that does not parse, or a field out of range |
| `signature_invalid` | 400 | the signature does not hold over the signing bytes |
| `signer_not_member` | — | the signer is not a drive account member on this PC (a record outcome) |
| `tombstoned` | — | the key was removed through the account; only this PC can let it back in (a record outcome) |
| `link_not_owner` | 403 | a link for another device, another PC, or a key that is not the row's |
| `key_in_use` | 409 | a link to a key another row already has |
| `introduction_unknown_key` | 404 | an introduction for a key no account member added on this PC |
| `introduction_invalid` | 400 | an introduction's PC list does not parse, or a `server_id` does not derive from its key |
| `introduction_none` | 404 | no introduction waits for this device |
| `account_unavailable` | 503 | the tombstone file cannot be read; no account record applies |

## What this does not protect against

- **A compromised PC in the middle of a remote approval** cannot swap the key on its own any more:
  the approver signs an `add` only for a key the account service lists as admitted at that PC
  (`GET /v1/admissions`), which only a device signed in to the account can post. A compromised PC
  together with a stolen sign-in still could.
- **A PC that stays off while the account service hides a removal** keeps the removed device until a
  client connects to it and hands over the record directly.
- **Relayed removals are best effort.** A client relays the removals it kept only when it brings a
  PC into the account, not ones it learns later; a PC from before relaying (#2956) drops one whose
  signer is not its member yet; a PC keeps at most 8 signers' records per removed key and at most
  1000 waiting records, and a client keeps at most 256. None of this admits a device: adds are not
  enrolled, so a new PC still lets the account's devices in only by approval.
- **A coding agent on the desktop app's machine** can drive the app's account key (rule 3). The same
  holds for a sign-in made in a browser on a PC's own address: that page's script is the PC's, so a
  compromised PC can use the sign-in kept there. Its account key is linked to no PC (a browser
  paired with a code holds a cookie), so its signatures admit nobody.
- **Someone who gets a person to type their device code at GitHub** (device-code phishing, true of
  every RFC 8628 sign-in) gets a sign-in to that person's account: they can list, rename and remove
  its PCs in the directory, fill mailboxes, post admissions and spend the ring budget. They still
  cannot add a device to a PC: that takes a member's signature and the PC's own `devices.json`, and
  a join is still compared digit by digit on a device already linked. The page asks to enter a
  code only if this page showed it, and GitHub's page names the app (Ovis).

## Code

- [`shared/account-records.ts`](../shared/account-records.ts): record types, parsing, signing bytes,
  signing and verification.
- [`shared/account-service-fake.ts`](../shared/account-service-fake.ts): the account service API in
  memory, for tests.
