# Performance audit: v0.4.12 to main

## Scope and verdict

The original investigation and plan below describe the release comparison at `60d9345f`.
The two P1 browser findings have since been implemented on current main; see
[Latest-main implementation](#latest-main-implementation) for the exact scope and new measurements.

- Release: `v0.4.12`, `1ed80e7913c4f904eb29d512aa252bf4b6480047`, published October 18, 2026 at 16:27:24 +09:00.
- Main: `60d9345f922b8118fc4dc31e35be7e999360e462`, verified against the remote main ref, 75 commits after the release.
- Environment: Linux x64, Ryzen 9 5950X, Bun 1.4.3, Node 24.18.0, Chrome 151.0.7922.173. Both client builds used the same installed dependency versions; the release-to-main dependency diff only adds server-side `jsonc-parser`.
- Measurements used synthetic data, disposable state directories and a fresh headless browser on a loopback ephemeral port. No live herdr session, transcript, credential, installed service or user browser profile was read or changed.

**The strongest general regression is the new finish/read-acknowledgement path, not a large increase in the client download.** It adds synchronous browser storage scans to status reconciliation, retains historical acknowledgement state, and synchronously rewrites the server's seen-record file. A separate prompt-reader refactor recomputes the same Omo form parsers three times. Closed-pane finish bookkeeping also grows with server lifetime.

These mechanisms and the fixture results below are confirmed. Their contribution to the user's particular slowdown is not yet quantified: this audit did not capture that device's performance trace, production heap, actual pane churn or real plugin event rate. Stress-test numbers must not be described as observed production latency or memory usage.

## Measurements

### Browser: status reconciliation and storage

A production-React harness imported the actual release and main `useSidebarActivityState` implementations. Each synthetic PC had 100 idle panes; finish keys were distributed across the PCs. Five warm-up updates preceded 30 new roster-array updates, separated by animation frames. The harness counted real `Storage.key` and `getItem` calls. Times measure the synchronous update, not page-load time or a complete app render.

| PCs | Stored finish records | Release mean/update | Main mean/update | Main p95/update | Main key enumerations/update |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 0.163 ms | 0.063 ms | 0.100 ms | 0 |
| 1 | 500 | 0.077 ms | 0.967 ms | 1.200 ms | 500 |
| 1 | 2,000 | 0.040 ms | 3.710 ms | 5.400 ms | 2,000 |
| 5 | 500 | 0.097 ms | 1.757 ms | 2.000 ms | 2,500 |
| 5 | 2,000 | 0.087 ms | 6.847 ms | 7.600 ms | 10,000 |

Release performed no storage enumeration in this hook. Main made 300,000 key enumerations and 60,000 value reads across the 30 updates in the last row. With empty storage there is no demonstrated slowdown; sub-millisecond release timings should not be used to advertise a precise speed ratio. Identical roster polls can be suppressed by `sameData`: the trigger is an actual roster/status, presentation or storage dependency change, not necessarily every five-second timer tick.

### Acknowledgement merge after storage eviction

The actual `markSeen` helper was run through the loop used by `useSidebarActivityState`, in Bun, with 2,000 loaded records and additional records retained from an earlier same-epoch state. Seven repetitions were used. This is an algorithm microbenchmark, not a Chrome latency measurement.

| Records absent from storage but retained in memory | Resulting record size | Median merge time |
| ---: | ---: | ---: |
| 0 | 2,000 | 0.342 ms |
| 100 | 2,100 | 14.394 ms |
| 500 | 2,500 | 83.393 ms |

Each missing record causes another whole-object spread. The next reconciliation starts from storage again and repeats the work. Thus the persistent 2,000-key cap does not bound the mounted hook's retained state or reconciliation cost.

### Prompt parsing

Both actual `parseInteractivePrompt` implementations parsed the same synthetic 50-line, no-dialog screen. Results are medians of nine batches of 1,000 parses, following 100 warm-up parses. No RPC or CLI invocation was involved.

| Agent | Release, 1,000 parses | Main, 1,000 parses | Ratio |
| --- | ---: | ---: | ---: |
| Claude | 498.174 ms | 853.519 ms | 1.71x |
| pi | 293.933 ms | 622.866 ms | 2.12x |
| Codex control | 118.584 ms | 123.682 ms | 1.04x |

This confirms additional parser CPU, not a 1.7–2.1x slowdown of the whole application. The ordinary fixture costs less than one millisecond per parse on this host. More simultaneous prompt readers and more pending Omo forms multiply it.

### Server persistence and retained finish state

`SeenStore.record`, populated with 500 synthetic records, was measured over nine batches of 50 changed acknowledgements:

| Answer fingerprint length | File size | Median time for 50 writes | Amortized per write |
| ---: | ---: | ---: | ---: |
| 128 characters | 97,992 bytes | 71.762 ms | 1.435 ms |
| 2,048 characters, maximum-length stress case | 1,057,992 bytes | 632.273 ms | 12.645 ms |

These calls execute synchronous filesystem operations on the event loop. Fifty finishes in a burst and maximum-length fingerprints are stress scenarios, not a claim about ordinary traffic. Identical acknowledgements already short-circuit.

A separate `Finishes` fixture used a constant fake daemon identity, ended every synthetic pane, and reconciled an authoritative empty snapshot. There were no live panes. Heap deltas are approximate Bun JavaScript-heap readings after explicit GC, not process RSS or a retained-heap graph.

| Closed unique panes | Entries still retained | Approximate heap delta | Empty snapshot median / p95 |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 6 KB | 0.001 / 0.006 ms |
| 10,000 | 10,000 | 1.55 MB | 0.456 / 0.768 ms |
| 100,000 | 100,000 | 15.06 MB | 22.543 / 28.976 ms |

The 100,000-pane case establishes scaling, not a realistic current session size. A small pane count cannot be assigned that memory cost.

### Client download and model catalogs

Actual production builds succeeded for both revisions:

| Asset measure | Release | Main | Change |
| --- | ---: | ---: | ---: |
| Entry JavaScript, minified | 1,774,065 B | 1,802,152 B | +28,087 B, +1.58% |
| Entry JavaScript, shipped Brotli sidecar | 461,749 B | 469,276 B | +7,527 B, +1.63% |
| All generated JavaScript | 19,096,702 B | 19,122,005 B | +25,303 B, +0.13% |
| JavaScript chunk count | 424 | 424 | unchanged |

All-chunk size includes lazy-loaded assets; it is not initial network transfer. Both builds still warn about chunks over 500 KB. The large entry bundle is an existing baseline cost, not a newly doubled bundle.

For 1,000 warm `piContextWindow` calls with absent catalogs, median time rose from 3.226 to 10.142 ms: main checks up to three files instead of one. With a first-file hit, the result was 2.779 versus 3.889 ms. This is lower priority than the measured acknowledgement costs. Parsed catalogs are cached and size-limited; incremental conversation paths exist, so this is not evidence of whole-transcript parsing on every poll.

## Prioritized fix list

Priority describes implementation order, not a claim of a production outage. P1 fixes target the common reconciliation path or unbounded retention; P2 fixes target narrower/bursty paths; P3 work needs additional workload evidence.

### P1 — Stop scanning localStorage during ordinary status reconciliation

**Evidence:** `src/lib/sidebarActivity.tsx:67-104`, `src/lib/seenFinishes.ts:37-47`, `src/components/AgentSidebar.tsx:101-109`. Introduced by the post-release finish/read-state work, principally `#1342` and `#1463`.

For M PCs and K origin storage keys, hydration currently performs O(MK) key visits on each relevant effect run. It also publishes a new seen-state map even when acknowledgements did not change, invalidating consumers' memoized row work.

**Change:** hydrate once per PC/epoch; consume targeted local-storage and server-seen deltas; separate hydration from presentation eligibility. Preserve state identity for unchanged acknowledgement values. A storage-clear event can trigger a full rehydrate; an unrelated status event must not.

**Acceptance:** after hydration, unrelated status changes perform zero storage enumeration and no acknowledgement-only state publication. Cross-tab maximum-ID convergence, blocked storage, explicit storage clearing, epoch retirement and presented-finish marking remain correct. Re-run the 5-PC/2,000-key fixture; use call counts as the deterministic gate and timing as supporting evidence.

### P1 — Bound client acknowledgement memory and merge once

**Evidence:** `src/lib/sidebarActivity.tsx:40,75-81,90-96`, `src/lib/sidebarOrder.ts:59-60`, `src/lib/seenFinishes.ts:97-110`.

Two distinct problems:

1. Previous same-epoch records reintroduce entries evicted from storage. For L loaded and E missing entries, repeated spreads copy O(EL + E²) properties.
2. `shared.current` retains a new string for each distinct finish/proof-presence combination, even for repeated finishes of one pane. Only transport failures remove entries.

**Change:** merge mutable local working records in one pass, publish an immutable result once, and impose an explicit bounded history policy separate from current active acknowledgements. Replace per-finish share-history strings with latest successfully shared/pending state per scoped pane; retries must not clear a newer acknowledgement. Retire known obsolete epochs/PCs. Do not treat an incomplete/disconnected roster as authoritative deletion.

**Acceptance:** state size plateaus under 10,000 completed turns of one pane and under synthetic pane/epoch churn; evicted records do not repeatedly resurrect. The eviction fixture performs one O(L+E) merge rather than E spreads. Preserve monotonic IDs, error/retry semantics and cross-device convergence.

### P2 — Compute the Omo form group once per prompt parse

**Evidence:** `server/prompt.ts:320-323`, `server/dialogs/omo.ts:548-554,570-590`; introduced by `#1435`.

Three registered readers independently call `forms()`, and each call runs the question, typing and review parsers. For K open asks, underlying calls increased from `3 * max(K,1)` to `9 * max(K,1)`. Claude, pi, Omo and unlabeled panes use these adapters.

**Change:** share prepared/lazy form results within one parse invocation. Keep the exactly-one-match ambiguity rule, reader order, fresh screen checks and prompt identities. Do not replace this with a process-wide screen cache or blindly stop at the first syntactic match.

**Acceptance:** exactly `3 * max(K,1)` underlying form parses for K=0/1/20; unchanged no-match, primary-Claude, typing, review and ambiguous-form outputs. Repeat the parser comparison with Codex as a control.

### P2 — Move seen persistence off the synchronous server event loop

**Evidence:** `server/seen.ts:33-51,90`; introduced by `#1463`.

A changed acknowledgement copies all retained entries, serializes them, synchronously creates/writes/renames the file, then rebuilds the map. For R updates of a B-byte store, approximately R*B bytes are rewritten. This competes with terminal transport callbacks on the same thread.

**Change:** serialize asynchronous atomic persistence; coalesce pending updates where possible. Resolve requests and publish seen events only after the corresponding merged state is committed. Retain the existing 500-record cap, monotonic merges, permissions, atomic replacement and error reporting. Do not make durability fire-and-forget.

**Acceptance:** fixture bursts produce bounded writes; identical updates write nothing; concurrent increasing/equal IDs converge; disk errors never publish unpersisted acknowledgements. Measure event-loop delay while writes are in flight, including a deliberately slow fixture writer.

### P2 — Reclaim closed-pane finish bookkeeping without reusing identities

**Evidence:** `server/finishes.ts:23,45-62,75-77`; introduced by `#1342`.

`ended()` retains each pane counter. Every subsequent snapshot scans the historical map and allocates another object for each absent pane. Cost follows lifetime pane churn, not live pane count.

**Change:** first make the finish identity contract support reclaimable pane incarnations, then retain only live/newer-observed state and explicitly bounded transient state. Use an existing authoritative incarnation identifier only if its reuse guarantees are established; otherwise carry an explicit finish incarnation through the shared protocol, persistence and browser evidence scope.

**Important dependency:** a single global finish counter is not a drop-in solution. `src/lib/panePresentation.ts` relies on same-pane consecutive IDs (`id > known.id + 1` is special). Blindly deleting counters, adding an LRU, or substituting a global sequence can acknowledge stale content or suppress valid finishes. Contract tests must precede this change; do not trade correctness for a flat heap.

**Acceptance:** after authoritative closure, 10k/100k distinct pane churn leaves bounded retained bookkeeping and empty-snapshot work independent of history. Same-ID reuse, stale snapshots, newer status observations, daemon restart, reconnects and already-read answers retain correct identity semantics. Do not reset all finish epochs periodically merely to hide growth.

### P3 — Narrow global DOM presentation observation

**Evidence:** `src/App.tsx:1016-1036`, `src/lib/panePresentation.ts:110-124`, `src/components/ChatView.tsx:1267-1293,1331-1339,1540-1541`.

New body-wide subtree/class observers trigger document-wide presentation/overlay queries; chat subtree mutations also trigger geometry checks. Terminal span churn and virtual-list updates can therefore cause unrelated proof work. Cleanup exists: this is not an established observer leak. No full-app long-task attribution was measured in this audit.

**Change after a trace confirms material cost:** use explicit overlay/presentation notifications or narrowly scoped observers; coalesce dirty checks per frame and avoid setting unchanged state. Preserve the rule that selected but obscured/unrendered content is not read.

**Acceptance:** one unrelated terminal mutation burst does not cause repeated global scans/layout reads. Dialogs, menus, hidden phone siblings, resize/keyboard changes, failed rendering and restored scroll positions keep correct acknowledgement behavior.

## Conditional follow-ups, not blanket rollback targets

- **Changing plugin display labels:** `server/collector.ts:333-336` routes label-only changes through structure invalidation. With machines enabled, each separated invalidation can cause both collector and manager snapshots plus whole-roster browser work. Use pane deltas, including explicit null clearing, instead. First count snapshots for synthetic label-only changes; constant labels do not incur this recurring cost.
- **Mirrored multiline input:** `server/pane-context.ts:45-47`, `server/core/input.ts:105-118`, `server/mirror-input.ts:25-38`. `#1441` adds full process/Omo-holder discovery before an agent-presence decision. Already-named agents can use a paste-specific fast path; unlabeled panes still need fresh evidence. This affects Windows/no-Node mirror paths, not every ordinary attached terminal keystroke.
- **Cold GJC status/chat overlap:** `server/gjc-runtime.ts:339-355,419-477`. `#1364` intentionally separates in-flight work by purpose to protect different deadlines. Equivalent cold callers can duplicate SDK processes; warm bindings remain shared. Optimize only with a gated subprocess-count fixture and separate execution ownership from observer deadlines. Simply removing the purpose distinction reintroduces timeout failures.
- **Pre-existing, not new regressions:** all-GJC transcript polling on unrelated status events (`server/core/status.ts:245-248`); loaded-chat-history projections; post-answer settling based on iteration count rather than elapsed time (`server/prompt.ts:1306-1318`). Keep these separate from the release-regression explanation.

## Terminal ownership findings

The scoped release/main comparison did not establish a new PTY/socket leak. Shared in-flight attachment creation, last-client teardown, stale-callback guards, output backpressure and the 128 KiB PTY replay budget already existed in the release (`server/core/terminals.ts`, `server/core/terminal-process.ts`, `server/core/connections.ts`, historical `server/index.ts`). The 100 ms output watchdog is also pre-existing, not a timer introduced by extraction.

Connection diagnostics retain bounded incident rings and issue incident-only, throttled reports. The new trace registry does require `close()`, but the production owner has that path: `MachineSession.close()` closes its socket; registry removal and provider unmount close sessions (`src/lib/machineSession.ts:88-125`, `src/lib/machineSessionContext.tsx:8-16`). No abandoned production owner was identified. These negative findings are source evidence plus focused socket tests, not a production heap-profile guarantee.

## Execution sequence

The initial investigation made no product changes. The implementation update below covers only
the two P1 browser findings; the independent server and parser changes remain separate work.

1. **Establish repeatable performance fixtures.** Promote the isolated storage, parser, seen-write and finish-churn probes into maintained regression/benchmark coverage. Capture count-based baselines and timing distributions; do not put brittle machine-specific milliseconds into unit assertions. Add a demo-only full-app trace with 1/5 PCs, 10/100 panes, empty/500/2,000 seen keys, streaming output, pane switching and repeated completion.
2. **Repair browser acknowledgement ownership.** Implement the two P1 items together because hydration, merging and share deduplication share state ownership. Cover storage-unavailable, multi-tab, remote-server and epoch-reset behavior before optimizing render identity.
3. **Remove duplicated prompt parsing.** A separate, small change can proceed independently of acknowledgement work. Preserve all interaction/ambiguity rules and verify parser call counts plus existing dialog cases.
4. **Repair asynchronous seen persistence.** Separate server change with deterministic concurrent-write/error tests and a slow-writer responsiveness fixture. Do not change success/durability semantics.
5. **Redesign and reclaim finish identity state.** Resolve the incarnation contract first, update every server/client/shared consumer and stale-content test, then remove historical retention. This is the highest correctness-risk item and should not be hidden inside a performance cleanup.
6. **Profile and address conditional paths.** Use the full-app trace to rank DOM observers, label invalidations, mirror discovery and cold GJC duplication. Do not perform a broad state-management rewrite or disable diagnostics on suspicion.
7. **Verify each independently releasable change.** Run focused behavioral and resource tests, then required Fast checks, Integration and browser, and Native Windows install for the changed union. Use only isolated sessions. Open verified PRs sequentially; this plan does not authorize merging or release.

### Release acceptance

- Ordinary status updates no longer enumerate persistent storage after hydration.
- Acknowledgement state and closed-pane bookkeeping have demonstrable lifetime bounds.
- No old draft is sent after reconnect; observe/take-over permissions and terminal output acknowledgements remain unchanged.
- Completion/read identity survives same-ID reuse, stale responses and cross-device races.
- Prompt parsing preserves cards and answer semantics while eliminating duplicate form work.
- Full-app traces show no newly introduced long-task trend; heap after repeated fixture lifecycle cycles plateaus after GC. Report browser heap, Bun heap, RSS, subprocess count and event-loop delay separately rather than calling all of them memory.

## Verification performed and limitations

- Built release and main successfully in temporary output directories. Both retain the existing >500 KB chunk warning.
- Ran 215 passing tests across eleven focused files, each file in its own Bun process: `server/seen.test.ts`, `server/pi-models.test.ts`, `server/herdr-sidebar.test.ts`, `src/lib/sidebarActivity.hook.test.ts`, `src/lib/panePresentation.test.ts`, `src/lib/paneCommandCache.test.ts`, `src/lib/connectionTrace.test.ts`, `server/finishes.test.ts`, `server/dialogs/registry.test.ts`, `server/core/connections.test.ts`, `src/lib/ws.test.ts`.
- Existing React test-renderer deprecation warnings were emitted. The seen-store corruption test emitted its expected temporary-file warning. Neither was suppressed.
- Ran the synthetic browser, merge, parser, catalog, seen-write and finish-retention measurements described above.
- Did not run the full integration/browser/native-platform matrix, a production heap profiler, or a device-specific performance recording. No claim is made that all user-visible slowness has been attributed.
- No evidence supports blaming the small new connection-diagnostic rings or file splitting itself for a large leak. Do not disable safety checks, diagnostics or newly added agent support as a shortcut.

### Reproduction notes

The local investigation used a disposable harness and raw JSON that were not kept (the PC's
temporary directory, not part of the repository). They were:

- `sidebar-probe.tsx`, `run-browser.ts`, `browser-results.json`
- `server-probe.ts`, `server-results.json`
- `finish-probe.ts`, `finish-results.json`
- `prompt-probe.ts`, `prompt-results.json`
- `merge-results.json`, `bundle-results.json`

The release sources were recovered with `git archive v0.4.12` / `git show v0.4.12:<path>`, not by checking out or mutating the active branch. Main built with `bun run build --outDir <temporary-directory>`; release built in its disposable archive with the same dependencies. All benchmark state was generated from counters and literal fixture text. The source revision, fixture dimensions, repetitions and observed distributions above are the durable evidence; the count-based regressions committed with the fix keep the measured bounds.

## Latest-main implementation

Revalidated on `7cd3648c`, then fast-forwarded onto `56a6877f4404f5fc7c4f8e671dcaca95a695e5b8`
before final verification. The audited browser finish-state files are unchanged between those
two main commits, and neither contains a fix for the measured storage scan or history retention.
The new main commit changes first-message delivery, which this implementation does not touch.

This change implements the two P1 items together:

- `seenFinishes.ts` owns a warm, bounded index of at most 2,000 records, shared with its scoped
  immutable read snapshots. A status update uses this index instead of enumerating localStorage.
- Same-page saves and server-seen batches notify only changed PC/epoch scopes. One window storage
  listener handles cross-tab writes, deletion and clear; the final subscriber releases the cache.
  A delayed clear reads current storage so it cannot erase a newer persisted acknowledgement.
- Storage access failures retain bounded mounted-page state. Session-only records retry persistence
  after storage access recovers. Actual deletions and clear invalidate cached read status.
- The hook publishes unchanged acknowledgement state by identity rather than creating a second
  render. Record snapshots are taken after all mutations so cross-PC eviction cannot publish an
  earlier stale snapshot.
- Share deduplication retains one latest attempt per scoped pane, capped at 2,000 panes, rather
  than one entry per completed turn. Late failures cannot erase a newer attempt; same-ID answer
  fingerprint upgrades and existing retry/error behavior remain intact.
- Obsolete `markSeen` and `seenEvent` helpers were removed. No new UI, setting, dependency,
  storage record schema or HTTP/WebSocket contract was introduced.

### Paired Chrome measurement

The real Chrome harness imported an archived `7cd3648c` hook and the changed hook into the same
production-React fixture. Their baseline sources are also identical at `56a6877f`. As in the
original fixture, each PC has 100 idle panes and each case has five warm-ups and 30 roster updates.
An animation frame plus a posted task lets React's follow-up commits settle between updates;
render counts therefore include the baseline's redundant acknowledgement commits.

| PCs / finish records | Main mean / p95 per update | Changed mean / p95 | Storage key visits, 30 updates | Hook renders, 30 updates |
| --- | ---: | ---: | ---: | ---: |
| 5 / 500 | 4.123 / 4.900 ms | 0.427 / 0.800 ms | 75,000 → 0 | 60 → 30 |
| 5 / 2,000 | 9.623 / 15.900 ms | 0.273 / 0.400 ms | 300,000 → 0 | 60 → 30 |

The 2,000-record case also reduced storage value reads from 60,000 to zero. This is a hook
microbenchmark, not a claim that the whole app is 35 times faster. Count-based regression tests
are the stable gate; latency varies with host load.

Focused verification passed 66 tests across `sidebarActivity.hook.test.ts`, `sidebarOrder.test.ts`
and `panePresentation.test.ts`. New cases cover warm-storage work and render counts, same-page
updates, mixed epochs, cross-PC eviction, cap enforcement, deletion/clear/remount, delayed clear,
foreign storage areas, access recovery, listener cleanup, share retries, stale promise results,
same-ID fingerprint upgrades and repeated turns beyond the history limit. React test-renderer
deprecation warnings remain; state-changing test actions are wrapped in `act`.

The paired harness and JSON (`sidebar-compare.tsx`, `compare-browser.ts` and
`browser-comparison.json`) were temporary like the rest and were not kept. Final Fast checks and full-app sidebar browser
verification are recorded in the PR validation receipt.

**Remaining, not fixed by this PR:** duplicate Omo parsing, synchronous server seen persistence,
closed-pane `Finishes` retention, and the conditional DOM/plugin/mirror/GJC follow-ups. They are
not bundled into this change because they have independent behavior and verification boundaries.
