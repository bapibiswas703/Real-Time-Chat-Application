# Storage model

## PostgreSQL: users and membership

`users`: UUID PK, unique Firebase UID, display name, nullable verified-source phone/email/avatar, UTC timestamps. Phone/email are **not** unique account-merging keys. `chats`: UUID PK, DIRECT enum, unique sorted `userAUUID:userBUUID` key, timestamps. `chat_participants`: composite PK `(chat_id,user_id)`, FKs with restricted deletion, joined timestamp; index `(user_id,chat_id)` supports own-chat listings and membership queries.

Prisma UUID defaults run in the application; timestamps default/updates follow the schema. Chat creation inserts chat and both members in one PostgreSQL transaction. A unique-pair race loser reads the winning row after its transaction rolls back. A reversed request uses the same normalized pair key.

Committed migration installs deferred constraint triggers on chats and participant inserts. At commit, the participant count must be two and their sorted IDs must equal the chat pair key. Participant UPDATE/DELETE triggers reject membership mutation. A third participant, a one-member chat or a changed mismatching pair key fails even outside application code. Application self-chat checks also reject before data access. DB roles must not be able to disable triggers/TRUNCATE data; use a separate migration owner and restricted runtime role. Superuser access is outside this enforcement boundary.

Chat list uses ascending UUID keyset pagination. UUID order is a stable traversal order, not most-recent activity. Relational members are fetched with Prisma's batched include/select relation queries, without per-chat queries. Chat updated_at is not a last-message timestamp and is not dual-written from Firestore.

## Firestore: messages and read state

`chats/{chatId}/messages/{id}`: senderId, text, createdAt server timestamp, clientRequestId or null, schemaVersion=1. A key produces SHA-256(senderUUID + ':' + key) as document ID, scoped by the chat path. Without a key, a random UUID is generated. Reuse with a different payload gives 409.

`chats/{chatId}/readReceipts/{messageId}_{userId}`: messageId, userId, readAt server timestamp. Only an incoming message can be marked read. The deterministic receipt ID and transaction preserve the first readAt across devices/retries.

`chats/{chatId}/userStates/{userId}`: lastSeenMessageId, lastSeenAt, updatedAt, and internal `order={seconds,nanoseconds,id}`. This pointer is independent of presence and does not bulk-mark earlier messages read. It may point at an outgoing message the user has seen. Lower tuple updates return 409; equal updates are no-ops.

Admin SDK accesses messages only after PostgreSQL membership authorization. No parent Firestore chat document is required: PostgreSQL owns chat existence. Chat IDs cannot be deleted or remapped through current APIs. There is no distributed FK; privileged manual writes must preserve invariants.

Default/forward history is ascending `(createdAt,__name__)`, capped at 100, with limit+1 pagination. Explicit `mode=latest` queries both fields descending, takes only limit+1, and reverses the returned page for chronological display. olderCursor excludes the previous oldest timestamp/ID tuple, including timestamp ties. Forward four-field cursors are unchanged; older cursors add `direction:"older"` and cannot be substituted for forward cursors. Latest responses expose `{items,olderCursor,headCursor}`, while forward responses keep `{items,nextCursor,syncCursor}`. Native seconds/nanoseconds are retained in opaque chat-bound cursors; ISO timestamps are display conveniences. Server writes are committed before snapshot reads/acknowledgements. An unresolved/malformed timestamp returns unavailable rather than a fabricated time. No unbounded collection scans, offsets or SQL message caches are used.

Queries use automatic single-field indexing: createdAt ascending/descending with the matching document-ID direction, and receipt messageId equality. No custom composite index is needed for these query shapes. `firestore.indexes.json` disables text indexing to avoid indexing private bodies. Emulator query tests do not establish that automatic indexes remain enabled in the live project; verify deployed indexing when releasing.

## Storage ownership

UsersRepository and ChatsRepository access PostgreSQL. MessagesRepository and ReadReceiptsRepository access their own Firestore collections. Services enforce identity and chat membership before repository operations. Redis stores only expiring coordination; its loss does not remove durable messages or read state. See [module boundaries](modular-monolith.md) and [failure handling](consistency.md).
