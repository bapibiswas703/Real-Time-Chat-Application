# Real-Time Chat Backend

A NestJS modular monolith for authenticated 1:1 messaging. PostgreSQL stores users, chats and immutable membership. Firestore stores messages, read receipts and last-seen-message state. Firebase Authentication handles Phone OTP and Google Sign-In. Redis coordinates presence, typing, rate limits and Socket.IO instances.

Modules use `controller/`, `service/`, `repository/`, `dto/`, `utils/` and `gateway/` folders where needed. Shared connections live in `src/shared/`; repositories stay private to their modules. [Architecture and source layout](docs/architecture/modular-monolith.md).

## Run locally

Use Node **22.22.1+**, npm, PostgreSQL and Redis. The default setup uses native local services and live Firebase; Docker is optional.

1. Run commands from the project root. Install dependencies with `npm ci`.
2. For a new setup, copy `.env.example` to `.env`. Preserve an existing `.env`.
3. Place the private Firebase Admin SDK JSON at `./firebase-adminsdk.json`. This file is excluded from Git and Docker. `firebase.json` is separate Firebase CLI configuration and contains no server credentials.
4. Configure the database password and Firebase project in `.env`. Create the local `chat` PostgreSQL database if needed.
5. Generate Prisma Client, apply migrations, verify Firebase and start the application:

```sh
npm run prisma:generate
npm run db:migrate
npm run firebase:check
npm run build
npm start
```

PowerShell setup: `Copy-Item .env.example .env` when no `.env` exists. The configured development defaults are PostgreSQL at `127.0.0.1:5432`, database `chat`, user `postgres`, and Redis at `127.0.0.1:6379`. URL-encode special characters in the PostgreSQL password. The example contains placeholders, never the local password or private key.

The Firebase credential path is:

```dotenv
FIREBASE_PROJECT_ID=real-time-chat-applicati-a640f
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json
```

Leave `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` unset for this profile. [Firebase setup and troubleshooting](docs/configuration/firebase-project.md).

| Address                 | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `http://localhost:3000` | API base URL; the root path has no frontend page  |
| `/docs`                 | Development Swagger UI when enabled               |
| `/health/live`          | Process liveness                                  |
| `/health/ready`         | PostgreSQL, Redis and Firestore read connectivity |

For development, run `npm run build:watch` and `npm run start:dev` in separate terminals. Firebase Auth verification is exercised by authenticated traffic, not readiness.

## Authentication and chat APIs

Clients sign in with the Firebase client SDK, obtain an ID token and send `Authorization: Bearer <idToken>`. Socket.IO uses `auth.token`. Call `POST /auth/session` or `GET /auth/me` to obtain the internal user UUID. Only Phone and Google sessions are accepted; the backend verifies signatures, expiry and revocation. [Security policy](docs/security/security-design.md).

| Method | Path                                    | Behavior                                       |
| ------ | --------------------------------------- | ---------------------------------------------- |
| POST   | `/chat/create`                          | Create/retrieve an unordered direct pair       |
| POST   | `/chat/:chatId/message/send`            | Persist a message and attempt live publication |
| GET    | `/chat/:chatId/messages`                | Read ascending timestamp/ID history            |
| POST   | `/chat/:chatId/message/:messageId/read` | Mark an incoming message read idempotently     |
| POST   | `/chat/:chatId/lastseen`                | Advance the caller's message pointer           |
| GET    | `/user/:userId/chats`                   | List the caller's chats                        |

Profile updates, own read state and receipt queries are also available. [REST contracts](docs/api/rest-api.md), [Socket.IO events](docs/api/socket-events.md).

Clients deduplicate by stable message ID and use `clientRequestId` for ambiguous-send retries. On reconnect, join first, buffer live packets and traverse history from the last committed `syncCursor`. Live packets never advance that checkpoint. SENT means persisted; READ requires an explicit receipt. Live publication is best effort. [Recovery and limits](docs/architecture/realtime-flow.md).

## Verification

```sh
npm run lint
npm run typecheck
npm run build
npm run test:coverage
npm run security:scan
npm audit --omit=dev
npm run firebase:check
```

The ordinary suite uses real HTTP/Socket transports with labeled identity/storage doubles. The separate infrastructure suite requires a disposable `chat_test` database, Redis and `demo-chat` Firebase emulators. It must never target the live profile. Java 21+ is needed only for those emulator checks. [Test setup and current evidence](docs/testing/test-strategy.md), [verification report](docs/security/final-audit.md).

## Deployment

Docker Compose is an optional local PostgreSQL/Redis setup. Its `chat` database user and authenticated Redis URLs must match the Compose password variables; avoid conflicting native-service ports. See [configuration](docs/configuration/firebase-project.md).

For deployment, set `NODE_ENV=production`, real Firebase project, exact HTTPS origins and authenticated PostgreSQL/Redis URLs. Inject credentials externally or use workload identity; mount a secret and set its runtime path rather than copying the local JSON into an image. The Docker image declares a non-root user. Use separate migration credentials and deploy Firestore rules/indexes through authorized release tooling.

Verify TLS/WSS, least-privilege IAM/SQL roles, Redis isolation, backups/restore, resource limits, real provider sign-in, load behavior, alerts and rollback. Current process capacity is 128 pending/active sockets with bounded renewal/authorization lanes. [Failure handling](docs/architecture/consistency.md), [data model](docs/architecture/data-model.md).
