// Focused repository guard. Reports paths/categories, never matching secret text.
const { spawnSync } = require('node:child_process');
const { readFileSync, lstatSync } = require('node:fs');
const { resolve, relative, isAbsolute } = require('node:path');

function inspect(path, text) {
  const findings = [];
  if (
    /(?:firebase[-_]adminsdk|service[-_]account|credentials).*\.json$/i.test(
      path,
    ) ||
    (/(?:^|\/)\.env(?:\..*)?$/.test(path) && !/\.env\.example$/.test(path))
  )
    findings.push('credential filename');
  const privateKey = new RegExp(
    '-----BEGIN ' + '(?:RSA |EC |OPENSSH |DSA )?' + 'PRIVATE KEY-----',
  );
  if (
    privateKey.test(text) ||
    (/"type"\s*:\s*"service_account"/.test(text) &&
      /"private_key"\s*:/.test(text))
  )
    findings.push('private key/service account');
  if (
    /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|1\/\/[A-Za-z0-9_-]{40,}/.test(
      text,
    )
  )
    findings.push('access credential');
  if (
    /eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}/.test(
      text,
    )
  )
    findings.push('JWT literal');
  return findings;
}
function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Git inventory unavailable');
  return result.stdout;
}
function run() {
  const files = new Set(
    git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean),
  );
  const staged = new Set(
    git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
      .split('\0')
      .filter(Boolean),
  );
  let count = 0;
  const check = (path, content, version) => {
    for (const category of inspect(path, content)) {
      process.stderr.write(`Secret scan: ${version} ${path}: ${category}\n`);
      count++;
    }
  };
  for (const path of files) {
    const absolute = resolve(path),
      fromRoot = relative(process.cwd(), absolute);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot))
      throw new Error('Unsafe repository path');
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error('Review symlinks before scanning');
    check(path, readFileSync(absolute, 'utf8'), 'worktree');
  }
  for (const path of staged) check(path, git(['show', `:${path}`]), 'staged');
  if (count) process.exitCode = 1;
  else
    process.stdout.write(
      `Secret scan: PASS (${files.size} repository files; ${staged.size} staged blobs). Ignored local credentials excluded.\n`,
    );
}
module.exports = { inspect };
if (require.main === module) {
  try {
    run();
  } catch {
    process.stderr.write('Secret scan failed to inspect repository.\n');
    process.exitCode = 1;
  }
}
