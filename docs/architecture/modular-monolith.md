# Modular monolith

One NestJS application contains seven business modules. Modules call each other's exported services in process; PostgreSQL, Firestore and Redis are shared external services. Conventional controllers, services, repositories and DTOs organize each module. Small pure helpers live in utils.

## Source layout

```text
src/
  modules/
    auth/           controller/ dto/ service/ auth.module.ts
    users/          repository/ service/ users.module.ts
    chats/          controller/ dto/ repository/ service/ utils/ chats.module.ts
    messages/       controller/ dto/ repository/ service/ utils/ messages.module.ts
    read-receipts/  controller/ dto/ repository/ service/ read-receipts.module.ts
    presence/       service/ presence.module.ts
    realtime/       dto/ gateway/ realtime.module.ts
  shared/
    database/ firebase/ redis/ observability/
  common/
    dto/ errors.ts http-auth.ts http-boundary.ts
  config/
  app.module.ts
  bootstrap.ts
  main.ts
```

Folders exist only where needed. Auth and presence do not need database repositories; realtime uses gateways rather than HTTP controllers. Shared providers initialize SDKs and connections. Small pure validation/order helpers live in utils.

Shared-root imports use `@/common/*`, `@/config/*` and `@/shared/*` in source and TypeScript tests. TypeScript paths and Jest mappings resolve these aliases during checking/tests. `npm run build` rewrites them to relative paths with tsc-alias after compilation, so `node dist/main.js` and the Docker runtime need no alias loader. Paths are relative to the tsconfig file; no deprecated baseUrl setting is required. Module-local imports stay relative.

Controllers validate DTOs and delegate to services. Services enforce caller ownership, membership and workflow rules. Repositories contain module-owned SQL/Firestore access, including transaction and uniqueness handling. Repository providers are private; modules export services only. There is no shared generic repository or cross-module repository injection.

| Module       | Responsibility                                                   | Public service      |
| ------------ | ---------------------------------------------------------------- | ------------------- |
| Auth         | Firebase verification/provider policy and current-user HTTP APIs | AuthService         |
| Users        | Verified UID mapping and profiles in PostgreSQL                  | UsersService        |
| Chats        | Direct pairs, membership checks and own-chat lists               | ChatsService        |
| Messages     | Validated sends, history and authorized message transactions     | MessagesService     |
| ReadReceipts | Incoming-message receipts and monotonic last-seen pointers       | ReadReceiptsService |
| Presence     | Redis device/typing leases and transient coordination            | PresenceService     |
| Realtime     | Authorized Socket.IO events and publication                      | Gateway only        |

Dependency direction: Auth → Users; Chats → Users; Messages → Chats; ReadReceipts → Messages + Chats; Realtime → Auth + Chats + Messages + ReadReceipts + Presence. There are no business-module cycles. Auth is global to support the global HTTP guard. Every private HTTP/socket operation still authorizes through services.

MessagesRepository owns Firestore message serialization and cursor queries. MessagesService exposes an authorized transaction callback for receipts/pointers, so message existence and receipt updates share one Firestore transaction without accessing another module's repository. ReadReceiptsRepository owns receipt/pointer storage and atomic monotonicity. ChatsRepository retains the PostgreSQL unique-pair transaction and race recovery.

The LiveEvents bus publishes after persistence. Messages does not import Realtime. Redis adapter server-side events reach other instances, each of which freshly verifies its local recipients. Presence renewal and expensive authorization/polling have separate bounded lanes. [Realtime budgets and recovery](realtime-flow.md) describe the limits.

## Data ownership and behavior

- PostgreSQL owns users/chats/membership; Firebase UID alone identifies accounts. Email/phone are profile fields, never merge keys.
- Direct membership is exactly two users and immutable, including SQL trigger enforcement. No blocking/removal/deletion/group upgrade exists.
- Firestore owns messages, receipts and last-seen pointers. A pointer may refer to an outgoing message; explicit receipts apply only to incoming messages.
- Default forward history is oldest-first with unchanged precise timestamp/ID cursors. Explicit `mode=latest` adds bounded recent/older history with direction-tagged olderCursor and chronological output. Initial headCursor seeds only a new recent-message window; older scrolling and live events never replace saved forward checkpoints. Own-chat listing uses stable UUID order rather than recent activity.
- Presence, typing and rate counters are temporary Redis state. Live publication is best effort; stable IDs, retry keys and committed history checkpoints support recovery.
- No distributed transaction, durable outbox or delivered-acknowledgement store is implemented. Add mutable membership only after designing cross-store authorization/revocation semantics.
- Node 22.22.1+, strict TypeScript and locked dependencies are retained. Firebase credentials use ADC/workload identity outside the repository.

[Data model](data-model.md), [failure handling](consistency.md), [API contracts](../api/rest-api.md), [security](../security/security-design.md), [verification](../testing/test-strategy.md).

### Latest-history decision

Keep one authorized messages endpoint with explicit `mode=latest`, rather than changing the existing no-cursor behavior or adding a second persistence implementation. MessagesService chooses/validates query combinations; MessagesRepository owns bounded Firestore queries. Controllers expose separate OpenAPI response models for both modes. The cursor codec shares tuple validation but keeps legacy forward bytes/shape and older direction markers separate. This is an additive query/protocol change: no SQL migration, Firestore document change, dependency, new business module or socket event is required. Recovery reuses the existing forward path and executable client reference.

## Configuration boundary

The local profile uses native PostgreSQL/Redis and live Firebase. The private root `firebase-adminsdk.json` is resolved through GOOGLE_APPLICATION_CREDENTIALS and excluded from source control/build context. Shared providers initialize connections; business modules consume them through dependency injection. See [Firebase configuration](../configuration/firebase-project.md).
