# Testing and verification

Run commands from the repository root. The normal `.env` profile connects to native local PostgreSQL/Redis and live Firebase. Ordinary unit/transport tests replace external services explicitly; isolated infrastructure tests use a separate configuration.

## Ordinary checks

```sh
npm run lint
npm run typecheck
npm run build
npm run test:coverage
npm run security:scan
npm run test:redis
npm audit --omit=dev
npm run firebase:check
```

| Suite                           | Coverage                                                                                                                                  | External dependencies                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `test/unit/`                    | Config, auth policy, SQL workflow, messages/receipts, cursor shape, safe errors, reconnect checkpoints, admission and heartbeat lifecycle | Explicit mocks/transaction doubles; fake clocks where needed     |
| `test/e2e/http.spec.ts`         | Actual Nest HTTP pipeline, chat APIs, OpenAPI, validation, spoofing and cross-user denial                                                 | Identity/storage doubles                                         |
| `test/e2e/socket.spec.ts`       | Actual Socket.IO handshake, private joins, messages, receipts, typing and revoked recipient checks                                        | Identity/storage/coordination doubles                            |
| `test/secret-scan.spec.cjs`     | Synthetic key/token detection and Git-ignore checks                                                                                       | Git and Node built-ins                                           |
| `test/secret-scan.cjs`          | Worktree/staged-blob credential filename/private-key/token scan                                                                           | Git and Node built-ins; not a complete history/all-formats audit |
| `test/firebase-cloud-check.cjs` | Actual Admin credential exchange, Auth permission and Firestore read; explicit opt-in write probe                                         | Live configured Firebase project                                 |

The current regression baseline is 82 ordinary tests across eleven suites, plus two Node secret-guard tests. Coverage and execution limits are in the [verification report](../security/final-audit.md). Transport tests are not labeled database integration.

Version/header regressions also cover configurable URI prefixes, production HSTS, development Swagger/CSP, unversioned liveness, pre-parser rejection, retry/reset headers, forged forwarded IPs, exact CORS, and denial before expensive authentication. `test/e2e/http-security.spec.ts` runs an isolated real HTTP server with a coordination double.

`npm run test:redis` selects only `test/integration/redis-rate-limit.spec.ts`. It uses the configured loopback Redis, verifies concurrent admission, expiry preservation, missing-TTL repair and the boolean socket limiter API, then deletes its own unique keys. It does not require Firebase emulators or touch existing application counters. The test rejects non-loopback Redis and non-test mode. The complete integration command still includes the separate Firebase-backed suite and requires its isolated prerequisites below.

## Isolated infrastructure tests

Use only a disposable `chat_test` PostgreSQL database, Redis and Firebase Auth/Firestore emulators. These tests must not consume the default live profile. Java 21+ is required. Configure process variables before starting the runner:

```dotenv
NODE_ENV=test
DATABASE_URL=postgresql://chat:TEST_PASSWORD@127.0.0.1:5432/chat_test
REDIS_URL=redis://:TEST_PASSWORD@127.0.0.1:6379
FIREBASE_PROJECT_ID=demo-chat
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
METADATA_SERVER_DETECTION=none
CORS_ORIGINS=http://localhost:5173
HTTP_RATE_LIMIT=2000
SOCKET_RATE_LIMIT=2000
```

Clear the live credential variable in this isolated process. Generate Prisma Client and apply migrations to the test database, then run `npm run test:emulators`. With test emulators already running, use `npm run test:integration`. After a build, `npm run test:smoke` checks compiled liveness/readiness and clean closure under that same isolated environment.

`test/integration/backend.spec.ts` covers real SQL pair races/invariants, Firestore transactions/cursors/receipts/pointers, Redis Lua/TTL/device behavior and two-instance Socket.IO publication. It explicitly rejects missing test prerequisites instead of skipping. Fixture accounts/chats remain in the disposable stores. Never weaken those guards to run against a live project.

Phone tests use the Auth Emulator's verification-code flow. Google tests use supported emulator-only provider fixtures before receiving a Firebase-minted ID token. These exercise backend provider policy, not real SMS/Google OAuth signatures or cloud provider setup. Emulator results do not prove deployed IAM, indexes or rules.

## CI and test runtime

GitHub Actions provisions PostgreSQL 17/Redis 7.4, Node 22 and Java 21. It runs the secret guard, lockfile install, Prisma generation/migration, lint, strict checking, dependency gates, ordinary tests, build, isolated integration and compiled smoke. Any production advisory fails; the full-tree gate fails moderate or higher while reporting disclosed low development advisories.

The Node build uses `module` and `moduleResolution` set to `NodeNext`, matching current Node package resolution. With the package's default CommonJS format, emitted application files remain CommonJS on Node 22.22.1+.

Jest uses native ESM TypeScript output through `tsconfig.jest.json`, ts-jest and the VM modules flag. Its `ES2022` module setting uses `bundler` resolution for Jest's transformed, extensionless imports. A narrowly scoped Babel transform handles Firebase Admin's synchronous `jose` dependency only in tests. Neither configuration uses the deprecated `node`/`node10` resolver.

TypeScript paths map `@/common/*`, `@/config/*` and `@/shared/*` to their source folders; Jest has matching moduleNameMapper entries. Build scripts run tsc-alias after tsc so compiled Node/Docker code uses relative requires. `npm run dev` uses tsc-watch and starts its server only after successful compilation and alias rewriting. `start:dev` invokes the same watcher; `build:watch` compiles/rewrites without starting a server. The two watch helpers are development dependencies only.

Record PASSED, FAILED, BLOCKED and NOT EXECUTED separately. Historical integration results do not establish a later revision's integration status. Actual provider login, container UID/signals, remote CI, cloud load/outages, restore and monitoring require their own evidence.
