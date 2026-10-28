// Read-only by default. --write opts into a uniquely named, cleaned-up probe.
// Never prints tokens, keys or user data, and never provisions cloud resources.
require('dotenv/config');
const { randomUUID } = require('node:crypto');
const {
  applicationDefault,
  initializeApp,
  deleteApp,
} = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'number' ||
    (typeof code === 'string' && /^(auth\/[a-z-]+|app\/[a-z-]+)$/.test(code))
    ? code
    : 'UNKNOWN';
}

async function run() {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID.startsWith('demo-') ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIRESTORE_EMULATOR_HOST
  ) {
    throw new Error(
      'Cloud check requires a real FIREBASE_PROJECT_ID and no emulator variables',
    );
  }
  const credential = applicationDefault();
  const app = initializeApp(
    { projectId: process.env.FIREBASE_PROJECT_ID, credential },
    `cloud-check-${randomUUID()}`,
  );
  const firestore = getFirestore(app);
  let failed = false;
  try {
    try {
      await credential.getAccessToken();
      process.stdout.write('Service-account credential exchange: PASS\n');
    } catch (error) {
      process.stdout.write(
        `Service-account credential exchange: FAIL (${safeCode(error)})\n`,
      );
      failed = true;
    }
    if (!failed) {
      // A random nonexistent UID tests the same get-user permission needed by
      // revocation-aware verification without retrieving an existing account.
      try {
        await getAuth(app).getUser(`connectivity-check-${randomUUID()}`);
        process.stdout.write('Firebase Authentication read access: PASS\n');
      } catch (error) {
        if (error?.code === 'auth/user-not-found')
          process.stdout.write(
            'Firebase Authentication read access: PASS (expected missing probe user)\n',
          );
        else {
          process.stdout.write(
            `Firebase Authentication read access: FAIL (${safeCode(error)})\n`,
          );
          failed = true;
        }
      }
      try {
        await firestore.doc('_health/connectivity').get();
        process.stdout.write('Firestore default database read access: PASS\n');
        if (process.argv.includes('--write')) {
          const probe = firestore
            .collection('_connectivity_checks')
            .doc(randomUUID());
          let created = false;
          try {
            await probe.create({ purpose: 'backend-connectivity', value: 1 });
            created = true;
            if ((await probe.get()).get('value') !== 1)
              throw new Error('Probe read mismatch');
            await firestore.runTransaction(async (tx) => {
              const snapshot = await tx.get(probe);
              if (snapshot.get('value') !== 1)
                throw new Error('Probe transaction mismatch');
              tx.update(probe, { value: 2 });
            });
            if ((await probe.get()).get('value') !== 2)
              throw new Error('Probe update mismatch');
          } finally {
            if (created) await probe.delete();
          }
          if ((await probe.get()).exists)
            throw new Error('Probe cleanup failed');
          process.stdout.write(
            'Firestore unique probe create/read/transaction/delete: PASS\n',
          );
        }
      } catch (error) {
        process.stdout.write(
          error?.code === 5
            ? 'Firestore default database read access: FAIL (NOT_FOUND: the default database is unavailable)\n'
            : `Firestore default database read access: FAIL (${safeCode(error)})\n`,
        );
        failed = true;
      }
    }
  } finally {
    await firestore.terminate();
    await deleteApp(app);
  }
  if (failed) process.exitCode = 1;
}
run().catch(() => {
  process.stderr.write(
    'Cloud check failed; verify configuration and credentials locally. No credential details displayed.\n',
  );
  process.exitCode = 1;
});
