// Fails when a tracked (or new, non-ignored) file outside test/fixtures/ holds keystore ciphertext or a
// 32-byte hex literal (private key, tx hash), with or without its `0x`. The repo is public: run this before every
// commit. A file that cannot be read fails the check (fail closed); only a path deleted from the working tree or a
// directory (a submodule) is skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIPPED_PREFIX = 'test/fixtures/';
// A keystore's ciphertext as a JSON key; docs that merely name the field do not match.
const KEYSTORE_CIPHERTEXT = /"ciphertext"\s*:/;
const HEX_32_BYTES = /0x[0-9a-fA-F]{64}/;
// A bare 64-hex-digit run (a private key pasted without `0x`), not part of a longer hex or alphanumeric token.
const BARE_HEX_32_BYTES = /(?<![0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/;
const SKIPPED_READ_ERRORS = new Set(['ENOENT', 'EISDIR']);

const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path !== '' && !path.startsWith(SKIPPED_PREFIX));

const findings = [];
for (const path of new Set(paths)) {
  let content;
  try {
    content = readFileSync(join(ROOT, path));
  } catch (error) {
    // Listed in the index but deleted from the working tree, or a directory; anything else is a failure.
    if (SKIPPED_READ_ERRORS.has(error?.code)) continue;
    throw error;
  }
  if (content.subarray(0, 8000).includes(0)) continue; // binary
  content
    .toString('utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (KEYSTORE_CIPHERTEXT.test(line)) findings.push(`${path}:${index + 1}: keystore ciphertext`);
      if (HEX_32_BYTES.test(line)) findings.push(`${path}:${index + 1}: 32-byte hex literal`);
      else if (BARE_HEX_32_BYTES.test(line)) findings.push(`${path}:${index + 1}: bare 32-byte hex literal`);
    });
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(`secrets check failed: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('secrets check ok');
