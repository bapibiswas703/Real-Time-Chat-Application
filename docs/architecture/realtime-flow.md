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

On reconnect: join first and buffer live events separately from the durable history checkpoint. Retrieve ascending history after the last successfully committed syncCursor, merge by ID and continue pagination until nextCursor is null. Commit the fetched page and its syncCursor atomically in client storage, including the final page. Never construct a checkpoint from a live packet or send acknowledgement. Receiving B does not establish receipt of earlier missed A; only traversing history from the old checkpoint does. Retain the previous committed position if a fetch or local commit fails. The displayed ISO timestamp loses ordering precision; use the opaque server cursor. If the client has no saved position, paginate from the oldest message. `test/fixtures/history-sync-client.ts` is an executable protocol reference, not a shipped frontend; unit and real infrastructure regressions exercise lost A followed by live B and ID deduplication.

## Admission limits

Socket admission checks the established private session and its expiry, then a synchronous per-connection fixed-window counter, Redis per-IP admission, and Redis per-user admission before Firebase/SQL work. Limits reject events without authorizing any operation; every admitted event still verifies the token and membership. Handshake IP/user admission and the process connection cap also apply. Shared IP keys use the transport's direct peer address, never an untrusted forwarded header. Behind a proxy this can aggregate traffic for many clients; configure a trusted edge limiter and capacity explicitly. Redis counters are shared across instances, but local counters/capacity are per process and reset on reconnect/restart. Fixed-window boundaries allow bursts. This is bounded admission, not a global hard concurrency quota or DDoS defense.

## Delivery guarantees

Redis Pub/Sub adapter has no durable replay or connection-state recovery. WebSocket-only transport avoids sticky-session requirements for polling. Delivery acknowledgement storage is intentionally absent: SENT=persisted; DELIVERED would require a recipient acknowledgement and durable semantics; READ=explicit receipt. No emission is labeled DELIVERED.
