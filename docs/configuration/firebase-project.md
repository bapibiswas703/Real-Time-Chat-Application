# Firebase configuration

The local backend uses project `real-time-chat-applicati-a640f`, native PostgreSQL/Redis and the `(default)` Firestore Native database in Mumbai (`asia-south1`). The browser Firebase configuration identifies a client app; Admin operations require server credentials.

## Local credential file

The private Admin SDK JSON is copied from Downloads to `firebase-adminsdk.json` in the project root. The original download is preserved. Both Git and Docker ignore the local copy; never stage it with a force option.

```dotenv
FIREBASE_PROJECT_ID=real-time-chat-applicati-a640f
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json
```

Run the backend and checks from the project root so the relative path resolves correctly. `.env` stores the actual local database configuration and is ignored. `.env.example` contains the same credential path and a PostgreSQL password placeholder. It contains no private key or actual password.

`firebase.json` is Firebase CLI/emulator configuration, not the private credential. Keep both files distinct.

For live Firebase, unset `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` in the shell as well as the env file. Existing process variables take precedence over dotenv. Remove local-only metadata overrides when using cloud workload identity.

## Providers and database

Enable Phone and Google authentication in the intended Firebase project. Configure authorized domains, reCAPTCHA and applicable SMS/provider settings for the client application. Clients obtain Firebase ID tokens after sign-in; the backend does not accept a web API key, raw Google token or arbitrary UID as authentication.

The backend passes the project ID explicitly and calls `getFirestore(app)`, selecting `(default)`. A named database in the same project does not automatically satisfy this configuration. Admin access is controlled by IAM; client Firestore access is separately controlled by security rules. The repository includes deny-all client rules and index configuration for an authorized release process.

## Connection checks

```sh
npm run firebase:check
# Optional, only when a write probe is intended:
node test/firebase-cloud-check.cjs --write
```

The default check exchanges credentials, checks Auth read permission using a random nonexistent UID and reads a health document. It never prints credentials or actual user data. The optional write mode creates a unique `_connectivity_checks` document, reads and updates it transactionally, deletes it and checks absence. Neither mode provisions a database, changes IAM or deploys rules.

A passing Admin check does not establish real Phone/Google client sign-in, every deployed rule, index coverage or production least privilege. The local default-database read passes; previous metadata/write checks and their limits are recorded in the [verification report](../security/final-audit.md).

## Troubleshooting

| Symptom                      | Check                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential file unavailable  | Run from the project root and verify the ignored JSON exists at the configured path. Do not print its contents.                               |
| Wrong project                | Check the explicit project ID and authorized IAM grants. A credential from another project needs deliberate cross-project permission.         |
| NOT_FOUND / code 5           | Inspect the selected project's database list using an authorized account; verify `(default)` exists. A denied listing does not prove absence. |
| PERMISSION_DENIED / HTTP 403 | Check API availability and IAM. Weakening client rules does not grant Admin IAM access.                                                       |
| Named database only          | Select it explicitly through a reviewed backend change, or have the owner create the intended default database.                               |
| Database genuinely absent    | The owner chooses a region and creates Native mode through Console or authorized tooling. Do not silently provision it.                       |
| Readiness failure            | Check PostgreSQL/Redis independently; readiness includes all three stores.                                                                    |

## Deployment credentials

Use workload identity/ADC or mount a managed secret and set an absolute runtime path such as `/run/secrets/firebase-adminsdk.json`. The local JSON and `.env` must stay outside the image and Git history. Apply least-privilege project access and rotate compromised credentials through the owning account. No cloud configuration change is part of local credential setup.

Docker Compose is optional. If used, its PostgreSQL user is `chat` and Redis requires the configured password; update the application URLs to match. The native example instead uses PostgreSQL user `postgres` and loopback Redis without authentication. Production requires authenticated services and reviewed TLS/private networking.
