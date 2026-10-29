# Real-Time Chat Backend

A NestJS modular monolith for authenticated 1:1 messaging. PostgreSQL stores users, chats and immutable membership. Firestore stores messages, receipts and last-seen-message state. Firebase Authentication handles Phone OTP and Google Sign-In. Redis coordinates presence, typing, rate limits and Socket.IO instances.

Run the complete application with **Docker Compose**, or run it directly with **Node.js and native PostgreSQL/Redis**. Both workflows use live Firebase. Modules use controller, service, repository, dto, utils and gateway folders; shared connections live in `src/shared/`. [Architecture](docs/architecture/modular-monolith.md).

## Firebase file for either workflow

Place the separately supplied private Admin SDK JSON in the repository root as `firebase-adminsdk.json`. Keep this file and actual env files local; Git and Docker exclude them. `firebase.json` is Firebase CLI configuration and is a different file.

The configured Firebase project is `real-time-chat-applicati-a640f`, with the `(default)` Firestore database in Mumbai (`asia-south1`). Phone and Google providers must be enabled for client sign-in. Leave Firebase emulator variables unset for both workflows below. [Firebase configuration](docs/configuration/firebase-project.md).

## Run with Docker Compose

### 1. Prepare configuration

Install Docker Engine/Desktop with Compose v2 and start the Docker engine. No host Node.js, PostgreSQL or Redis installation is needed for this workflow.

From the repository root, create a separate local Docker profile:

```sh
cp .env.example .env.docker
```

PowerShell: `Copy-Item .env.example .env.docker`. Preserve an existing env file. Edit these values in `.env.docker`:

```dotenv
APP_PORT=3000
POSTGRES_USER=chat
POSTGRES_DB=chat
POSTGRES_PASSWORD=ChooseALocalPostgresPassword
REDIS_PASSWORD=ChooseALocalRedisPassword
FIREBASE_PROJECT_ID=real-time-chat-applicati-a640f
FIREBASE_CREDENTIALS_FILE=./firebase-adminsdk.json
CORS_ORIGINS=http://localhost:5173
SWAGGER_ENABLED=true
```

Use alphanumeric local passwords in this Compose profile: its internal connection URLs interpolate those values directly. The native `DATABASE_URL`, `REDIS_URL` and `GOOGLE_APPLICATION_CREDENTIALS` values in the copied example are overridden by Compose. The container uses service hosts `postgres`/`redis` and mounts the Firebase file read-only at `/run/secrets/firebase-adminsdk.json`.

If a native server already occupies port 3000, stop it or set `APP_PORT=3001`. PostgreSQL and Redis stay on the private Compose network, so existing native ports 5432 and 6379 can remain running.

### 2. Build and start

```sh
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up --build --wait
```

Compose starts four services:

| Service    | Purpose                                                      |
| ---------- | ------------------------------------------------------------ |
| `postgres` | PostgreSQL 17 with a persistent named volume                 |
| `redis`    | Password-protected Redis 7.4 for transient coordination      |
| `migrate`  | One-shot Prisma migration using the build's CLI/dependencies |
| `app`      | Compiled Node 22 API, running as the non-root node user      |

The API waits for healthy PostgreSQL/Redis and successful migrations. `migrate` exiting with code 0 is expected. The Firebase key is mounted only into the API; it is not copied into either image. Local Compose sets `NODE_ENV=development` so localhost CORS and Swagger work; production validation remains enabled when running with `NODE_ENV=production`.

### 3. Verify and inspect

```sh
docker compose --env-file .env.docker ps -a
docker compose --env-file .env.docker logs --tail=100 app migrate
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Use the chosen `APP_PORT` in URLs. In PowerShell, `Invoke-RestMethod http://localhost:3000/health/ready` is also available. Liveness reports process health; readiness additionally checks PostgreSQL, Redis and a Firestore read. Check Firebase credentials/project/IAM if readiness fails.

### 4. Stop or restart

```sh
docker compose --env-file .env.docker down
docker compose --env-file .env.docker up --build --wait
```

`down` preserves the PostgreSQL volume and its data. Keep the same database credentials when reusing that volume; changing the env password does not change an already initialized database user's password. Redis presence/typing state is transient. Do not remove database volumes unless intentionally discarding their data.

## Run directly with Node.js

### 1. Prepare local services

Install Node **22.22.1+**, npm, PostgreSQL and Redis. Start the native services and create a PostgreSQL database named `chat`. The example uses PostgreSQL user `postgres` and loopback Redis without authentication; adjust these to match your machine.

```sh
cp .env.example .env
```

PowerShell: `Copy-Item .env.example .env` for a new setup. Preserve an existing `.env`. Configure:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/chat
REDIS_URL=redis://127.0.0.1:6379
FIREBASE_PROJECT_ID=real-time-chat-applicati-a640f
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json
CORS_ORIGINS=http://localhost:5173
SWAGGER_ENABLED=true
```

Replace the password placeholder and URL-encode special characters. Docker-specific `APP_PORT`, `POSTGRES_*`, `REDIS_PASSWORD` and `FIREBASE_CREDENTIALS_FILE` variables do not configure the native process; it uses the explicit connection URLs and credential path above.

### 2. Install, migrate and start

Run from the repository root:

```sh
npm ci
npm run prisma:generate
npm run db:migrate
npm run firebase:check
npm run build
npm start
```

For development, use one terminal:

```sh
npm run dev
```

The watcher compiles TypeScript, resolves the shared path aliases, and restarts the server after each successful compilation. `npm run start:dev` is an alias for the same workflow. Use `npm run build:watch` only when you need compilation without starting a server. Press Ctrl+C to stop the watcher and server.

## Addresses and authentication

Business routes use `/api/v1`. Configure `API_PREFIX=api` and `API_VERSION=1` in either local profile; Compose forwards both values. Changing these values changes the URI contract. Swagger is at `/api/v1/docs`, while `/health/live` and `/health/ready` stay unversioned. Legacy unprefixed business routes are not aliases.

| Address                        | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `http://localhost:3000`        | API base; no frontend is served at `/`       |
| `http://localhost:3000/api/v1` | Versioned REST base                          |
| `/api/v1/docs`                 | Development Swagger UI when enabled          |
| `/health/live`                 | Process liveness                             |
| `/health/ready`                | PostgreSQL, Redis and Firestore connectivity |

Use `APP_PORT` for Docker or `PORT` for native execution when changed from 3000. Firebase Auth verification is exercised by authenticated traffic, not readiness.

Clients sign in using Firebase, obtain an ID token and send `Authorization: Bearer <idToken>`. Socket.IO uses `auth.token`. `POST /api/v1/auth/session` or `GET /api/v1/auth/me` returns the internal user UUID. Only Phone and Google sessions are accepted; expiry and revocation are checked. [Security model](docs/security/security-design.md).

| Method | Path                                           | Behavior                                       |
| ------ | ---------------------------------------------- | ---------------------------------------------- |
| POST   | `/api/v1/chat/create`                          | Create/retrieve a direct pair                  |
| POST   | `/api/v1/chat/:chatId/message/send`            | Persist a message and attempt live publication |
| GET    | `/api/v1/chat/:chatId/messages`                | Forward sync or latest/older ordered history   |
| POST   | `/api/v1/chat/:chatId/message/:messageId/read` | Mark an incoming message read                  |
| POST   | `/api/v1/chat/:chatId/lastseen`                | Advance the caller's message pointer           |
| GET    | `/api/v1/user/:userId/chats`                   | List the caller's chats                        |

[REST contracts](docs/api/rest-api.md), [Socket.IO events](docs/api/socket-events.md), [reconnection and limits](docs/architecture/realtime-flow.md). Clients deduplicate by ID, retry ambiguous sends with clientRequestId, and advance history checkpoints only after committed fetched pages. SENT means persisted; READ requires an explicit receipt. Live publication is best effort.

### Open a conversation and scroll up

```http
GET /api/v1/chat/CHAT_ID/messages?mode=latest&limit=50
GET /api/v1/chat/CHAT_ID/messages?mode=latest&limit=50&olderCursor=OLDER_CURSOR
GET /api/v1/chat/CHAT_ID/messages?limit=50&cursor=SAVED_SYNC_CURSOR
```

The first request loads the most recent 50 messages in chronological display order: 4951–5000 in a 5000-message chat. Latest/older responses contain `{items,olderCursor,headCursor}`. Scroll up with olderCursor; null means no older page. Default/`mode=forward` retains the original `{items,nextCursor,syncCursor}` behavior and cursor format. Maximum page size is 100. Do not mix cursor types or modes.

Register live handlers before joining the authorized Socket.IO room; wait for its acknowledgement before reading history. Room join does not return messages. For a **new** local conversation window, atomically save the initial latest page and its headCursor as the starting forward checkpoint, then forward-sync to catch traffic arriving during loading. Retain a separate olderCursor. If a saved sync checkpoint already exists, resume from it instead of replacing it with a new latest head, which could skip offline messages. Live events, send acknowledgements and older pages never advance/reset that forward checkpoint. Merge by ID and sort by seconds/nanoseconds/ID. See the [complete initialization/reconnect protocol](docs/architecture/realtime-flow.md#history-synchronization) and executable `test/fixtures/history-sync-client.ts`; the real-store integration harness exercises synthetic Bapi/Satadal identities, never personal accounts.

## Verification and deployment

```sh
npm run lint
npm run typecheck
npm run build
npm test
npm run test:redis
npm run security:scan
npm audit --omit=dev
```

These host-side checks need Node/npm. Unit/transport tests use labeled doubles; separate integration tests require disposable stores and Firebase emulators, not the live profile. [Test setup](docs/testing/test-strategy.md), [verification evidence](docs/security/final-audit.md).

`test:redis` is an independent real loopback-Redis check that uses unique temporary counters and deletes them afterward; it does not need Firebase emulators. HTTP admission is Redis-backed: IP quota runs before JSON parsing, then token-digest admission before verification and a verified-user quota afterward. The default is 120 per 60-second window for each policy. Responses expose `RateLimit-*`; HTTP 429 adds `Retry-After` in seconds. Only cheap liveness and CORS preflight bypass that admission. Readiness, Swagger and unknown routes are limited.

Helmet supplies CSP, anti-framing, no-sniff and referrer protections; API responses disable caching and the Express identification header. HSTS and HTTPS-upgrade CSP apply only in production, preserving localhost HTTP development. CORS rejects origins outside the exact allowlist, and untrusted forwarded IP headers cannot change the quota key. [Security behavior](docs/security/security-design.md).

For deployment, use production mode, HTTPS origins, authenticated/private database and Redis connections, least-privilege SQL/IAM roles and externally managed credentials. The migration image includes tooling; the runtime image excludes development dependencies. Verify deployed Firestore rules/indexes, TLS/WSS, backups/restore, resource limits, real provider login, load behavior, signals, monitoring and rollback. [Failure handling](docs/architecture/consistency.md), [storage model](docs/architecture/data-model.md).
