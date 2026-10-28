# REST API reference

Server origin: `http://localhost:3000`; the default REST base is `http://localhost:3000/api/v1`. Endpoint paths below include `/api/v1`. All business routes require a Firebase ID token in `Authorization: Bearer TOKEN`. Body and query objects reject unknown properties. UUIDs normalize to lowercase. Client-supplied identity fields must match the verified internal PostgreSQL user ID. All POSTs return 201; reads/PATCH return 200. These examples use shell variables for previously obtained tokens and internal IDs.

```sh
BASE=http://localhost:3000/api/v1
curl -X POST "$BASE/auth/session" -H "Authorization: Bearer $TOKEN"
curl "$BASE/auth/me" -H "Authorization: Bearer $TOKEN"
curl -X PATCH "$BASE/auth/profile" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"displayName":"Alice","avatarUrl":"https://example.com/avatar.png"}'
```

Profiles return internal id, displayName, email, phoneNumber, avatarUrl and UTC timestamps. Only the authenticated owner receives these fields. Profile updates cannot change identity, provider, phone or email. Avatar URLs are stored links only; the server does not fetch them.

## Chat operations

| Method | Route                                        | Request fields                   |
| ------ | -------------------------------------------- | -------------------------------- |
| POST   | /api/v1/chat/create                          | userAId, userBId                 |
| POST   | /api/v1/chat/:chatId/message/send            | senderId, text, clientRequestId? |
| GET    | /api/v1/chat/:chatId/messages                | limit?, cursor?                  |
| POST   | /api/v1/chat/:chatId/message/:messageId/read | userId                           |
| POST   | /api/v1/chat/:chatId/lastseen                | userId, messageId                |
| GET    | /api/v1/user/:userId/chats                   | limit?, cursor?                  |

## Create or retrieve a chat

```http
POST /api/v1/chat/create
Authorization: Bearer TOKEN_A
Content-Type: application/json

{"userAId":"00000000-0000-4000-8000-000000000001","userBId":"00000000-0000-4000-8000-000000000002"}
```

Response: `{"chatId":"00000000-0000-4000-8000-000000000003"}`. Reversed ordering and concurrent identical pairs return the same chat. Caller must be A or B, both must exist, and IDs must differ.

## Send a message

```http
POST /api/v1/chat/CHAT_ID/message/send
Authorization: Bearer TOKEN_A
Content-Type: application/json

{"senderId":"USER_A_ID","text":"Hello","clientRequestId":"deviceA-request-001"}
```

Send senderId and text; clientRequestId is optional. Keys contain 1–128 ASCII letters/digits/underscore/hyphen and are scoped to chat + sender. Text must contain non-whitespace, have 1–4000 JavaScript UTF-16 code units, and contain no NUL. HTML is plain message text; consuming clients must render escaped text, never inject it as HTML.

```json
{
  "id": "stable-message-id",
  "chatId": "CHAT_ID",
  "senderId": "USER_A_ID",
  "text": "Hello",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "seconds": 1793188800,
  "nanoseconds": 123,
  "clientRequestId": "deviceA-request-001",
  "schemaVersion": 1
}
```

Success means Firestore committed. Retries with the same key/text return the same identity; changed text returns 409. A failed/ambiguous response may follow a committed write; use the key to retry safely.

## Message history

`GET /api/v1/chat/CHAT_ID/messages?limit=50&cursor=OPAQUE_CURSOR`

Returns `{"items":[MESSAGE],"nextCursor":"opaque-or-null","syncCursor":"opaque-or-null"}`. Default limit 50, maximum 100. Ordering is ascending server timestamp seconds/nanoseconds, then document ID ascending. nextCursor is present only when more records existed during the page read; null ends the current traversal. syncCursor always retains the last returned position (or the input cursor for an empty page) for later reconnection. New messages can arrive afterward. History never marks messages read or advances last-seen state.

The cursor contains exactly `{chatId,seconds,nanoseconds,id}` as base64url JSON, never message text or sender metadata. Maximum input length is 1024 characters; extra fields, invalid types/ranges/IDs and another chat's cursor are rejected. It is a position, not an access token; membership authorization applies before every history read.

Keep a separate durable history checkpoint per chat. Join first and buffer live events, then fetch ascending history after the last committed syncCursor. Commit each successfully fetched page and its syncCursor together in client storage; continue using nextCursor until null, saving syncCursor on the final page too. If fetching or local persistence fails, resume from the last committed page. Deduplicate history, live events and send acknowledgements by stable message ID. **Never advance the history checkpoint from a live event or send acknowledgement:** later live B does not prove earlier A was received. An empty page preserves the input position. A new client starts with no cursor and traverses from the oldest message. Keep only one synchronization loop active per chat. See the executable client protocol reference in `test/fixtures/history-sync-client.ts` and its lost-A/live-B regression tests.

## Mark an incoming message read

```http
POST /api/v1/chat/CHAT_ID/message/MESSAGE_ID/read
Authorization: Bearer TOKEN_B
Content-Type: application/json

{"userId":"RECIPIENT_USER_ID"}
```

Returns `{chatId,messageId,userId,readAt}`. Message must exist in the chat, caller must be a participant and must differ from the sender. Repeated requests preserve the original server readAt. Sender may read receipts through `GET /api/v1/chat/CHAT_ID/message/MESSAGE_ID/receipts`, returning `{items:[{messageId,userId,readAt}]}`.

## Set the last-seen-message pointer

```http
POST /api/v1/chat/CHAT_ID/lastseen
Authorization: Bearer TOKEN_B
Content-Type: application/json

{"userId":"USER_ID","messageId":"MESSAGE_ID"}
```

Returns `{userId,lastSeenMessageId,lastSeenAt}`. Message must exist in the same chat. Equal updates are idempotent; lower `(seconds,nanoseconds,id)` updates return 409. This operation does not create receipts or change online presence. `GET /api/v1/chat/CHAT_ID/lastseen` retrieves the caller's pointer; null fields mean unset.

## List your chats

`GET /api/v1/user/USER_ID/chats?limit=50&cursor=CHAT_UUID`

Returns `{items:[{chatId,type:"DIRECT",createdAt,memberIds:[A,B]}],nextCursor}`. Order is chat UUID ascending, with UUID keyset cursor. The caller must be USER_ID. Member email/phone and Firebase UID are never included. The cursor convention differs from message history; do not mix them.

## Rate-limit headers

The default HTTP limit is 120 requests per 60-second fixed window (`HTTP_RATE_LIMIT`). IP admission covers HTTP routes before JSON parsing, including Swagger, readiness, missing tokens, malformed bodies and unknown routes. An opaque bearer-token digest is limited before costly verification; the verified user is also limited afterward. Hashes are admission keys, never authentication evidence. The counters are shared through Redis across instances; direct peer IPs are used with trust-proxy disabled.

`RateLimit-Limit` reports the quota, `RateLimit-Remaining` the lowest remaining quota, and `RateLimit-Reset` a conservative relative number of seconds until the encountered windows reset. `RateLimit-Policy` describes the fixed window. A 429 response includes `Retry-After` in seconds and the normal safe error body. Redis failure returns 503 without an in-memory fallback. Fixed-window boundaries permit bursts; ingress controls remain necessary.

`GET /health/live` and its HEAD equivalent stay cheap and independent of Redis. Valid CORS preflight is handled before quota consumption. `/health/ready` remains public but rate limited. Business routes require the versioned prefix; socket transport stays at `/socket.io`.

## Errors and transport limits

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Chat access denied",
    "requestId": "server-generated-uuid"
  }
}
```

| Status | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| 400    | Validation, self-chat, outgoing receipt, malformed cursor              |
| 401    | Missing/invalid/expired/revoked/disabled/unsupported-provider identity |
| 403    | Identity spoofing or chat access denied                                |
| 404    | Participant/message not found, unknown route                           |
| 409    | Conflicting retry key or stale last-seen                               |
| 413    | JSON payload exceeds 16 KiB                                            |
| 429    | Redis-backed configurable rate limit                                   |
| 503    | Authentication/storage/coordination unavailable; retry safely          |

Unknown and inaccessible chat IDs deliberately return the same 403. X-Request-Id is generated per HTTP request. Error responses do not expose validation values, credentials, message bodies or raw SDK errors. Health endpoints are public and should be ingress restricted/rate-limited; all business routes fail closed if Redis rate limiting is unavailable.

See [Socket.IO events](socket-events.md) for live updates and [failure recovery](../architecture/consistency.md) for ambiguous writes and dependency outages.
