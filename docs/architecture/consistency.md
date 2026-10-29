# Consistency and recovery

## Failure responses

| Failure                                             | Observable behavior                                                                                                  | Recovery                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Invalid/expired/revoked/disabled token              | 401 / rejected socket                                                                                                | Sign in or refresh using Firebase           |
| Firebase verification outage                        | 503 / disconnect                                                                                                     | Retry after service recovers                |
| PostgreSQL outage                                   | Authorization fails closed; no new message write                                                                     | Retry with same request key                 |
| Concurrent pair creation                            | One unique pair wins                                                                                                 | Loser returns winning chat ID               |
| Firestore write fails                               | No successful send acknowledgement or publication                                                                    | Retry same key                              |
| Firestore commit succeeds, response read fails      | Ambiguous error; write may exist                                                                                     | Retry same key and identical text           |
| Persistence succeeds, process dies before broadcast | Message remains durable, notification may be absent                                                                  | History synchronization / keyed retry       |
| Redis unavailable                                   | HTTP rate-limited routes fail closed; socket event fails, socket disconnects on refresh; live publication suppressed | Restore Redis, reconnect, catch up          |
| Redis Pub/Sub connection alone fails                | Cross-instance notification can be lost while main Redis connection remains healthy                                  | History synchronization; adapter reconnects |
| Stale last-seen update                              | 409; pointer unchanged                                                                                               | Keep newer pointer                          |
| Duplicate read                                      | Original receipt returned                                                                                            | No action                                   |
| Unexpected socket disconnect                        | Device lease expires/removes; other devices remain online                                                            | Reconnect + history                         |

## Cross-store boundaries

PostgreSQL and Firestore are separate commit domains. There is no dual-write relational last-message cache or distributed transaction. Membership cannot change through this release's APIs or ordinary participant UPDATE/DELETE. If mutable membership is introduced, add a deliberate authorization epoch/revocation protocol before allowing it to race cross-store writes.

## Transaction boundaries

Firestore message creation and retry validation run in a transaction. Receipt/message existence and receipt creation share a transaction. Pointer/message existence and pointer ordering share a transaction. Transaction callbacks do not broadcast or perform external side effects, because Firestore can retry them.

## Client recovery

LiveEvents is ephemeral; there is no outbox or replay worker. The durable history plus idempotency key is the current recovery contract, not a guarantee that every connected client sees every push. Retry without a key can create a second message. Key retention lasts as long as the message. Ordering is by committed server timestamp then ID; this does not claim causal ordering between distinct concurrent senders.

Latest loading and scroll-up traversal use independent boundaries. A new local window commits its initial latest snapshot and headCursor together, then repairs the snapshot-to-live race using forward sync. A returning client resumes its existing forward cursor; replacing it with the most recent page can skip older missed messages. Older pages never modify the forward checkpoint. A live B arriving without A also never advances it. Both query directions assume immutable messages with server-generated creation time; administrative backdated inserts/deletions are not covered. No cursor requires loading a boundary document, so pagination position is the validated timestamp/ID tuple, not message content or an access credential.

## Revocation and health checks

Authorization has an unavoidable small verification-to-transmission race with a remote account revocation. Rechecks on every event, before each broadcast, and periodic renewal bound idle socket cleanup without caching token verification. Already-transmitted data cannot be recalled. Dependency checks inside readiness are bounded to 3 seconds; its earlier Redis admission command can also take up to its configured 5-second timeout. Configure probe timeouts accordingly. Underlying SDK work may continue after a bounded response. Liveness stays independent of Redis; ingress must still protect public probe traffic.
