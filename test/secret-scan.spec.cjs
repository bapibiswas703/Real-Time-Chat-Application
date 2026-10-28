const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { inspect } = require('./secret-scan.cjs');

test('detects Admin SDK files, private keys and tokens without returning their values', () => {
  assert.deepEqual(
    inspect('nested/project-firebase-adminsdk-test-123.json', '{}'),
    ['credential filename'],
  );
  const key = '-----BEGIN ' + 'PRIVATE KEY-----\n' + 'fixture-only';
  assert.deepEqual(inspect('config.txt', key), ['private key/service account']);
  assert.deepEqual(inspect('config.txt', 'gh' + 'p_' + 'x'.repeat(36)), [
    'access credential',
  ]);
  assert.deepEqual(
    inspect(
      'config.txt',
      'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(30),
    ),
    ['JWT literal'],
  );
  assert.deepEqual(inspect('.env.example', 'DATABASE_URL=placeholder'), []);
  assert.deepEqual(inspect('.env.production', 'FIREBASE_PROJECT_ID=example'), [
    'credential filename',
  ]);
  assert.deepEqual(inspect('.env', 'PASSWORD=placeholder'), [
    'credential filename',
  ]);
});
test('Git ignores default Firebase Admin SDK names at root and nested paths', () => {
  const names = [
    'example-firebase-adminsdk-test-123.json',
    'nested/example-firebase-adminsdk-test-123.json',
    'nested/example_firebase_adminsdk_test.json',
  ];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: names.join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), names);
});
