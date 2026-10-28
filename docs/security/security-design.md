# Security model

## Trust boundaries

Firebase establishes identity. PostgreSQL establishes user/chat membership. Firestore persists messages and read state. Redis coordinates temporary state and event transport. Every private operation must pass backend authentication and authorization even if a client has joined a socket room.

## Authentication

Clients complete Phone OTP or Google Sign-In through Firebase and send a Firebase ID token. The backend uses revocation-aware verification and accepts only `phone` or `google.com` sign-in providers. Expired, revoked, disabled, anonymous, custom-provider and unsupported-provider sessions are rejected.

The verified Firebase UID maps to one PostgreSQL user. Email/phone are profile fields, never account-merge keys. Only verified email claims are copied initially. Profile updates cannot alter identity or provider data. Account linking and provider identity changes belong to authenticated Firebase flows.

Client sign-out clears its local Firebase session; the client must also disconnect its socket. It does not invalidate every previously issued token. Account-wide invalidation requires privileged token revocation or disabling the Firebase user. No public backend endpoint exposes arbitrary user creation, account linking or global revocation.

## Authorization

- REST identity comes from the bearer token. Socket identity comes from a private established-session Map, never a submitted UID or socket.data.
- Submitted senderId/userId and own-chat listing IDs must match the verified internal user UUID.
- Chat operations use membership-filtered SQL queries. Missing and inaccessible chats return the same denial.
- A message must exist in the requested chat. Explicit receipts apply only to incoming messages; last-seen pointers must not regress.
- Incoming socket events and private outgoing delivery recheck authorization. Admission limits reject work but never authorize it.
- Lifecycle fencing prevents late async work from updating or notifying a disconnected session. Existing-only Redis renewal prevents removed leases from reappearing.

Admitted events and recipients retain fresh revocation checks. Separate bounded maintenance disconnects expired/stale/overdue sessions. A remote revocation can still race the final verification-to-send interval; already transmitted data cannot be recalled. [Lifecycle and limits](../architecture/realtime-flow.md).

## Validation and browser access

DTOs reject unknown fields, normalize UUIDs and validate types/ranges. Message text is capped at 4000 UTF-16 code units, history pages at 100, and JSON/socket frames at 16 KiB. Cursors contain ordering fields only and are bound to the chat. Parameterized SDK queries replace user-built SQL.

CORS uses exact configured origins, Helmet adds response headers, and APIs use bearer tokens rather than cookies. Native clients may omit Origin but still require authentication. Profile avatar URLs allow HTTPS and are not fetched server-side. Clients must render message text safely rather than inject HTML.

## Local secrets and deployment credentials

The local private credential is `firebase-adminsdk.json` at the project root, referenced by `GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json`. `.env` contains actual local connection values. Both files are excluded from Git; the JSON and env values are also excluded from Docker context. `.env.example` contains only a credential path and password placeholders.

The repository secret guard scans current files and staged blobs for credential filenames, private keys, common access credentials and JWT literals. It prints categories/paths, never matching values. It is not a guarantee against every secret format or historical leak. Do not force-add ignored credential files.

Deployment should use workload identity or externally mounted/injected secrets. Limit IAM to the intended project and required Firestore/Auth operations. Admin SDK access bypasses client rules, so backend authorization and IAM remain essential. Deny-all client rules are supplied; their actual deployment is an independent check.

Separate SQL migration ownership from runtime permissions. Runtime roles must not own schema, disable constraints/triggers or truncate membership data. PostgreSQL uniqueness, foreign keys and deferred triggers enforce direct-chat invariants. The local development superuser is not a deployment role.

## Redis and operational controls

HTTP and socket limits fail closed on coordination failure; typing has its own window. The backend uses the direct peer address with trust-proxy disabled. Configure a reviewed ingress/proxy topology and restrict/rate-limit public health routes. Shared fixed-window counters and process-local caps do not replace ingress traffic controls.

Presence leases last 30 seconds; typing leases last 5 seconds. Redis server time controls expiry. Adapter channels carry private payloads and are trusted internal infrastructure. Use private networking, authentication/ACLs and TLS according to the environment. Main and adapter connections can fail independently; durable history is the recovery path.

Logs contain route templates, request IDs, timings and counters. They exclude private keys, tokens, OTPs, profile contact data and message bodies. Raw SDK errors are not returned to clients. Avoid unredacted SDK debug logging in deployed environments.

## Failure and release checks

Auth/SQL outages deny access. Failed Firestore persistence does not produce success. A commit followed by a lost response is ambiguous and requires a stable retry key. Redis loss can block protected operations and interrupt live publication; no permissive in-memory fallback is implemented.

Validate real provider sign-in, revoked/disabled users, least privilege, deployed rules/indexes, TLS/WSS, container UID/signals, quotas/load, backups/restore, alerting and rollback. [Consistency](../architecture/consistency.md), [current verification](final-audit.md).
