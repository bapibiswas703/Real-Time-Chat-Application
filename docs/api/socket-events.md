# Socket.IO protocol

## Connect and authenticate

Use Socket.IO 4.x over WebSocket transport. `SERVER_ORIGIN` is the server origin, such as `http://localhost:3000`, without the REST `/api/v1` suffix. The Engine.IO path stays `/socket.io`; REST versioning does not change namespaces or event names:

```ts
const socket = io(SERVER_ORIGIN, {
  transports: ['websocket'],
  auth: { token: await firebaseUser.getIdToken() },
});
socket.emit('chat:join', { chatId }, (ack) => {
  if (ack.ok) synchronizeHistoryAndMergeByMessageId(chatId);
});
socket.emit(
  'message:send',
  {
    chatId,
    senderId: internalUserId,
    text: 'Hello',
    clientRequestId: 'deviceA-001',
  },
  handleAck,
);
```

Provider authentication uses the Firebase client SDK; internalUserId comes from `/api/v1/auth/me`. Reconnect with a refreshed Firebase ID token when the existing token expires. Invalid handshakes get a generic connect_error. Room joins authorize access but never replace per-event/per-recipient checks. Maximum 100 joined chats per connection, 128 established/pending connections per process and 16 KiB inbound frames. Excess capacity gets the same generic handshake error.

## Acknowledgements and validation

All client events require object payloads, reject unknown fields, verify identity and authorize chat access. Acknowledgements use `{ok:true,data:...}` or `{ok:false,error:{code,message,requestId}}`. Send a Socket.IO acknowledgement callback (or use emitWithAck with timeout). A disconnect/network failure may prevent an acknowledgement after persistence; retry keyed sends and synchronize history.

## Events

| Direction       | Event                | Payload / response                                               |
| --------------- | -------------------- | ---------------------------------------------------------------- |
| client → server | chat:join            | `{chatId}` → `{chatId,syncRequired:true}`                        |
| client → server | chat:leave           | `{chatId}` → `{chatId}`                                          |
| client → server | message:send         | `{chatId,senderId,text,clientRequestId?}` → persisted message    |
| server → client | message:new          | Persisted message, same contract as REST                         |
| client → server | message:read         | `{chatId,messageId,userId}` → `{chatId,messageId,userId,readAt}` |
| server → client | message:read:updated | `{chatId,messageId,userId,readAt}`                               |
| client → server | typing:start         | `{chatId}` → `{chatId,userId,typing,expiresInMs}`                |
| client → server | typing:stop          | `{chatId}` → `{chatId,userId,typing,expiresInMs}`                |
| server → client | typing:start         | `{chatId,userId,typing:true,expiresInMs:5000}`                   |
| server → client | typing:stop          | `{chatId,userId,typing:false,expiresInMs:0}`                     |
| server → client | presence:updated     | `{chatId,userId,online:boolean}`                                 |

## Payloads and expiry

User IDs and chat IDs are UUIDs; message IDs/key strings are ASCII letters/digits/underscore/hyphen, max 128. Typing's initial/expiry hints and presence snapshots are sent only to authorized joined members, periodically every five seconds when observed state changes. Clear typing locally on expiry even if disconnected; timing hints are approximate. Typing start should be refreshed only while composing.

## Reconnect and deduplicate

Messages/receipts may be emitted more than once. Deduplicate message:new by id and receipts by `(chatId,messageId,userId)`. The success ack and message:new may arrive in either order. Connection-state recovery is not enabled. On reconnect join, buffer live packets and run one history synchronization loop per chat from the last durably committed syncCursor. Persist each fetched history page and its cursor atomically, continuing through nextCursor until null. Live packets and send acknowledgements update the display buffer only; they never advance this checkpoint. If A was missed and later B arrived live, history still fetches both from the old checkpoint, merging by ID. Retry from the last committed page after fetch/storage failure. Reading history is not a read acknowledgement. See [history contract](rest-api.md#message-history) and the executable protocol reference `test/fixtures/history-sync-client.ts`.

## Admission and authorization

Cheap local connection, shared IP and shared identity limits run before expensive event verification. Admitted events and private delivery retain fresh token and membership checks. A separate bounded maintenance lane revalidates identities and polls joined chats; Redis lease renewal cannot wait behind that work. Maintenance deadlines or stale/expired identities disconnect clients. The [realtime design](../architecture/realtime-flow.md) documents TTL budgets, metrics, load assumptions and multi-instance/proxy limiter limitations.

## Delivery semantics

No `delivered` event or durable delivered state is implemented. Socket emission and adapter publication do not prove recipient receipt. Redis Pub/Sub may lose packets during connection failure; history remains the recovery authority.
