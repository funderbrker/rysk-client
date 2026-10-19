import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Hex, keccak256, toHex } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

// Web3 Secret Storage v3 with the parameters Foundry's `cast wallet import` writes (scrypt, aes-128-ctr).
// Foundry omits `address` and writes hex without `0x`; both hex forms are accepted. Error messages never
// carry the password, the derived key or the private key.

export class KeystoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeystoreError';
  }
}

type JsonObject = Record<string, unknown>;

const SCRYPT_MAXMEM = 512 * 1024 * 1024;
const DKLEN = 32;
const HEX_BYTES = /^(?:0x)?((?:[0-9a-fA-F]{2})+)$/;

function objectAt(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KeystoreError(`keystore ${field} is not an object`);
  }
  return value as JsonObject;
}

function bytesAt(value: unknown, field: string, length?: number): Buffer {
  const digits = typeof value === 'string' ? HEX_BYTES.exec(value)?.[1] : undefined;
  if (digits === undefined) throw new KeystoreError(`keystore ${field} is not hex`);
  const bytes = Buffer.from(digits, 'hex');
  if (length !== undefined && bytes.length !== length) {
    throw new KeystoreError(`keystore ${field} is ${bytes.length} bytes, expected ${length}`);
  }
  return bytes;
}

function positiveIntAt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new KeystoreError(`keystore ${field} is not a positive integer`);
  }
  return value;
}

/** Returns the `0x`-prefixed 32-byte private key; throws `KeystoreError` on a wrong password or bad file. */
export function decryptKeystore(json: string, password: string): Hex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KeystoreError('keystore is not valid JSON');
  }
  const keystore = objectAt(parsed, 'file');
  if (keystore.version !== 3) {
    throw new KeystoreError(`unsupported keystore version ${String(keystore.version)}`);
  }
  const crypto = objectAt(keystore.crypto, 'crypto');
  if (crypto.kdf !== 'scrypt') throw new KeystoreError(`unsupported keystore kdf ${String(crypto.kdf)}`);
  if (crypto.cipher !== 'aes-128-ctr') {
    throw new KeystoreError(`unsupported keystore cipher ${String(crypto.cipher)}`);
  }

  const kdfparams = objectAt(crypto.kdfparams, 'kdfparams');
  const salt = bytesAt(kdfparams.salt, 'kdfparams.salt');
  const dklen = positiveIntAt(kdfparams.dklen, 'kdfparams.dklen');
  if (dklen !== DKLEN) throw new KeystoreError(`unsupported keystore dklen ${dklen}, expected ${DKLEN}`);
  const N = positiveIntAt(kdfparams.n, 'kdfparams.n');
  const r = positiveIntAt(kdfparams.r, 'kdfparams.r');
  const p = positiveIntAt(kdfparams.p, 'kdfparams.p');
  const iv = bytesAt(objectAt(crypto.cipherparams, 'cipherparams').iv, 'cipherparams.iv', 16);
  const ciphertext = bytesAt(crypto.ciphertext, 'ciphertext', 32);
  const mac = toHex(bytesAt(crypto.mac, 'mac', 32));

  let dk: Buffer;
  try {
    dk = scryptSync(Buffer.from(password, 'utf8'), salt, dklen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  } catch (cause) {
    throw new KeystoreError('keystore scrypt parameters rejected', { cause });
  }
  if (keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])) !== mac) {
    throw new KeystoreError('mac mismatch: wrong password or corrupted keystore');
  }
  const decipher = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  return toHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

export function loadAccount(path: string, password: string): PrivateKeyAccount {
  return privateKeyToAccount(decryptKeystore(readFileSync(path, 'utf8'), password));
}

type PasswordSources = {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  prompt: (msg: string) => Promise<string>;
  readFile: (p: string) => string;
  fileMode: (p: string) => number;
};

/**
 * Prompts when stdin is a TTY; otherwise reads `KEYSTORE_PASSWORD_FILE`, refused unless owner-only, less one
 * trailing line break (editors and `echo` add one); any other whitespace is the password's. A `KEYSTORE_PASSWORD`
 * environment variable is deliberately unsupported.
 */
export async function resolvePassword(opts: PasswordSources): Promise<string> {
  if (opts.isTTY) return opts.prompt('Keystore password: ');
  const path = opts.env.KEYSTORE_PASSWORD_FILE;
  if (!path) throw new KeystoreError('no password source: run interactively or set KEYSTORE_PASSWORD_FILE');
  const permissions = opts.fileMode(path) & 0o777;
  if ((permissions & 0o077) !== 0) {
    const mode = permissions.toString(8).padStart(4, '0');
    throw new KeystoreError(
      `KEYSTORE_PASSWORD_FILE ${path} is accessible by group or others (mode ${mode}); run chmod 600 on it`,
    );
  }
  return opts.readFile(path).replace(/\r?\n$/, '');
}
