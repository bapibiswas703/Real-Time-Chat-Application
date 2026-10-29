# Realtime lifecycle and recovery

## Connection and persistence

Clients complete Firebase sign-in, connect to Socket.IO with `auth.token`, and join a chat using `chat:join`. The server verifies the token with revocation checking, resolves the PostgreSQL user, validates the payload and checks membership. Tokens stay in a local private Map, never socket.data or Pub/Sub session metadata.

REST and `message:send` call MessagesService: identity → text/key validation → membership → Firestore transaction → committed snapshot → application publication → response/ack. Publication starts asynchronously; the live event may race the response. Clients must accept either arrival order and deduplicate by message ID. Persistence always precedes success and notification. Idempotent retries may re-publish the same message to repair a missed notification.

The internal bus triggers local recipient delivery and a Redis adapter server-side event. Remote instances run the same local delivery routine. Each recipient token and chat membership is rechecked before content transmission, with at most 32 simultaneous recipient checks per publication. Authorization failure disconnects the socket, revoking all rooms. Admitted incoming events still perform fresh revocation-aware verification and chat authorization. Clients refresh tokens in the Firebase SDK and reconnect with a new token; there is no unauthenticated in-place identity change.

## Presence lifecycle and renewal budget

Redis maintains per-device sorted-set leases using Redis server time. Online means at least one unexpired 30-second device lease. Only handshake registration creates a lease; heartbeat renewal atomically requires an existing unexpired device member. Disconnect removes only its own device. A late renewal cannot recreate it, even when Redis completion races cleanup. Socket IDs serve as generation identifiers, and asynchronous auth/polling work rechecks the exact private session instance and connection before side effects. A crashed process disappears after expiration.

Every five seconds two independent lanes run: lightweight Redis renewal and expensive identity/chat/presence polling. Each lane has at most 32 workers, cannot overlap itself, and the process admits at most 128 established plus pending connections. Four Redis batches at the configured five-second command timeout plus a five-second scheduling allowance fit inside the 30-second TTL (25 seconds). This is a scheduling budget, not a measured production latency guarantee. Maintenance disconnects a device after a five-second job deadline; late results cannot update or notify the removed session. Timed-out SDK calls are not magically cancelled: they retain worker slots until settlement, preventing unbounded replacement work. Renewal also disconnects expired identities or identities without successful verification within ten seconds. Dependency failures can therefore reduce availability while preserving authorization. Under healthy load, maintenance must complete within each five-second cadence; large joined-chat sets or slow SDKs can exceed that budget and disconnect clients. The 100-chat protocol cap is not a throughput guarantee.

Metrics include `presence_renewal_cycles`, cumulative `presence_renewal_duration_ms`, `presence_renewal_overlaps`, `presence_renewal_budget_exceeded` (20 seconds), `presence_errors`, `socket_maintenance_overlaps`, `socket_maintenance_timeouts` and `socket_stale_auth`. Alert on overlap, deadlines and lease budget exhaustion. The automated scheduling test uses 50 synthetic connections with delayed authentication; production load/cost testing is still required before increasing the 128-connection cap. Polling only joined-chat members restricts visibility. Healthy crash/offline observation normally takes up to about 35 seconds; degraded dependencies can delay observation or disconnect observers.

## Typing expiry

Typing uses 5-second per-device leases and a separate configurable rate limit. A stop removes one device; another device's active lease keeps the user typing. Clients expire typing locally using `expiresInMs`, even if no stop arrives. Polling sends a stop when state expires. These are transient hints, never durable account state.

## History synchronization

### Room initialization

1. Authenticate with Firebase Phone/Google using the client SDK and obtain a Firebase ID token.
2. Call `/api/v1/auth/session` or `/api/v1/auth/me` to resolve the internal PostgreSQL UUID.
3. Fetch `/api/v1/user/USER_ID/chats`, then select an authorized conversation.
4. Create an authenticated Socket.IO session with `auth.token`. Register live/read handlers **before** requesting room join; retain separate per-chat buffers.
5. Send `chat:join` and wait for `{ok:true,data:{chatId,syncRequired:true}}`. An error stops initialization. This acknowledgement contains no messages.
6. For a **new** local history window, GET `/api/v1/chat/CHAT_ID/messages?mode=latest&limit=50`; it returns only the newest page, ordered chronologically. Keep buffering events throughout the read and local commit.
7. Atomically persist the initial page, its headCursor as the new forward checkpoint, and its independent olderCursor. Older messages outside this initial window have deliberately not been fetched. An empty page has a null head, so subsequent forward sync starts with no cursor. Persist window existence even in this empty case; restoring it must resume forward without a cursor, not reinitialize latest and skip an offline backlog.
8. Forward-sync after the committed headCursor, continuing with nextCursor until null, atomically committing each fetched page and its syncCursor. This catches writes after the latest snapshot, including notifications lost during loading. Live events and send acknowledgements cannot advance this position.
9. Merge history, buffered events and acknowledgements by stable message ID, then sort by `(seconds,nanoseconds,id)` for display. Millisecond ISO timestamps alone are insufficient.
10. Scrolling up uses `mode=latest&olderCursor=...`. Commit each older page and its next olderCursor; prepend/merge by ID. Ignore that older page's headCursor and leave the forward checkpoint unchanged.
11. On reconnect/foregrounding, obtain a current token, reconnect and rejoin, then forward-sync from the **saved** checkpoint. Do not replace it with a newly fetched latest head: that could skip a large offline backlog. Repeat sync on a suitable cadence when continuous loss repair is needed while still connected.
12. If any fetch or atomic local commit fails, retry from the corresponding last committed position. Serialize initialization, older paging and forward synchronization per chat to avoid checkpoint races. Do not mark messages read just because history was loaded.

The original default/forward mode remains oldest-first when no cursor is supplied; existing consumers and four-field cursors are unchanged. Latest mode is explicit and uses a separate direction-tagged olderCursor. Each database query reads at most limit+1 documents, maximum 101; only that page is reversed. A snapshot's head can initialize a new window, whereas a live packet cannot establish a contiguous history frontier. SQL membership is checked before either Firestore history query. Immutable server-timestamped messages are assumed; privileged backdating, editing or deleting history is outside this release's recovery contract.

`test/fixtures/history-sync-client.ts` is the executable protocol reference, not a shipped frontend or browser persistence implementation. `new HistorySyncClient<PersistedMessage>(null, compareOrder)` provides ordered ID merging, `initializeLatest`, `loadOlder`, and existing `synchronize`. Its commit callbacks represent an atomic durable client store and must be implemented by the consuming client. `notification` never changes a checkpoint. Saved forward checkpoints use the constructor and `synchronize`; initialization refuses to overwrite them. A consumer must restore its cached pages and separate positions after process restart; the fixture itself keeps data in memory.

`test/unit/latest-history.spec.ts` injects live B while A is lost between initial snapshot and commit, tests failed local commits and older paging, and traverses 5000 tied-timestamp records. The real-store harness in `test/integration/backend.spec.ts` uses isolated Bapi/Satadal identities, actual Firebase emulator tokens, PostgreSQL, Firestore, Redis and Socket.IO. It tests empty-room opening during a live arrival, two-way messages, retry deduplication, read updates, disconnect/rejoin catch-up and lost-A/live-B recovery. The separate 5000-record emulator fixture verifies the real descending query and complete older traversal. No real personal identities/conversations are used.

## Admission limits

Socket admission checks the established private session and its expiry, then a synchronous per-connection fixed-window counter, Redis per-IP admission, and Redis per-user admission before Firebase/SQL work. Limits reject events without authorizing any operation; every admitted event still verifies the token and membership. Handshake IP/user admission and the process connection cap also apply. Shared IP keys use the transport's direct peer address, never an untrusted forwarded header. Behind a proxy this can aggregate traffic for many clients; configure a trusted edge limiter and capacity explicitly. Redis counters are shared across instances, but local counters/capacity are per process and reset on reconnect/restart. Fixed-window boundaries allow bursts. This is bounded admission, not a global hard concurrency quota or DDoS defense.

## Delivery guarantees

Redis Pub/Sub adapter has no durable replay or connection-state recovery. WebSocket-only transport avoids sticky-session requirements for polling. Delivery acknowledgement storage is intentionally absent: SENT=persisted; DELIVERED would require a recipient acknowledgement and durable semantics; READ=explicit receipt. No emission is labeled DELIVERED.
