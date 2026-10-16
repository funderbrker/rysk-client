import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { decryptKeystore, KeystoreError, loadAccount, resolvePassword } from './keystore.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/keystore-anvil0.json', import.meta.url));
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');
const PASSWORD = 'hunter2';
const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

type Keystore = {
  version: unknown;
  crypto: {
    cipher: unknown;
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: unknown;
    kdfparams: { salt: string };
    mac: string;
  };
};

function editedFixture(edit: (keystore: Keystore) => void): string {
  const keystore = JSON.parse(FIXTURE) as Keystore;
  edit(keystore);
  return JSON.stringify(keystore);
}

describe('decryptKeystore', () => {
  it('decrypts the Foundry fixture to the Anvil #0 key', () => {
    expect(privateKeyToAccount(decryptKeystore(FIXTURE, PASSWORD)).address).toBe(ANVIL0);
  });

  it('accepts 0x-prefixed and uppercase hex fields', () => {
    const prefixed = editedFixture(({ crypto }) => {
      const upper = (hex: string) => `0x${hex.toUpperCase()}`;
      crypto.cipherparams.iv = upper(crypto.cipherparams.iv);
      crypto.ciphertext = upper(crypto.ciphertext);
      crypto.kdfparams.salt = upper(crypto.kdfparams.salt);
      crypto.mac = upper(crypto.mac);
    });
    expect(decryptKeystore(prefixed, PASSWORD)).toBe(decryptKeystore(FIXTURE, PASSWORD));
  });

  it('throws a mac mismatch for a wrong password', () => {
    expect(() => decryptKeystore(FIXTURE, 'hunter3')).toThrow(KeystoreError);
    expect(() => decryptKeystore(FIXTURE, 'hunter3')).toThrow(/mac/i);
  });

  it.each([
    ['malformed JSON', 'not json', /JSON/],
    ['an unsupported version', editedFixture((k) => (k.version = 1)), /version/],
    ['an unsupported kdf', editedFixture((k) => (k.crypto.kdf = 'pbkdf2')), /kdf/],
    ['an unsupported cipher', editedFixture((k) => (k.crypto.cipher = 'aes-128-cbc')), /cipher/],
    ['a non-hex ciphertext', editedFixture((k) => (k.crypto.ciphertext = 'zz')), /ciphertext/],
  ])('throws KeystoreError for %s', (_case, json, message) => {
    expect(() => decryptKeystore(json, PASSWORD)).toThrow(KeystoreError);
    expect(() => decryptKeystore(json, PASSWORD)).toThrow(message);
  });
});

describe('loadAccount', () => {
  it('reads and decrypts a keystore file into an account', () => {
    expect(loadAccount(FIXTURE_PATH, PASSWORD).address).toBe(ANVIL0);
  });
});

describe('resolvePassword', () => {
  const PASSWORD_FILE = '/secrets/wheel.password';
  const REGULAR_FILE = 0o100000; // file-type bits as `statSync(path).mode` reports them

  function sources(overrides: Partial<Parameters<typeof resolvePassword>[0]> = {}) {
    return {
      isTTY: false,
      env: {},
      prompt: vi.fn(async () => 'typed'),
      readFile: vi.fn(() => ' from-file \n'),
      fileMode: vi.fn(() => REGULAR_FILE | 0o600),
      ...overrides,
    };
  }

  it('prompts when stdin is a TTY', async () => {
    const opts = sources({ isTTY: true, env: { KEYSTORE_PASSWORD_FILE: PASSWORD_FILE } });
    await expect(resolvePassword(opts)).resolves.toBe('typed');
    expect(opts.prompt).toHaveBeenCalledWith('Keystore password: ');
    expect(opts.readFile).not.toHaveBeenCalled();
  });

  it('reads KEYSTORE_PASSWORD_FILE trimmed when it is owner-only', async () => {
    const opts = sources({ env: { KEYSTORE_PASSWORD_FILE: PASSWORD_FILE } });
    await expect(resolvePassword(opts)).resolves.toBe('from-file');
    expect(opts.fileMode).toHaveBeenCalledWith(PASSWORD_FILE);
    expect(opts.readFile).toHaveBeenCalledWith(PASSWORD_FILE);
  });

  it('refuses a KEYSTORE_PASSWORD_FILE readable by group or others', async () => {
    const opts = sources({
      env: { KEYSTORE_PASSWORD_FILE: PASSWORD_FILE },
      fileMode: vi.fn(() => REGULAR_FILE | 0o644),
    });
    await expect(resolvePassword(opts)).rejects.toThrow(KeystoreError);
    await expect(resolvePassword(opts)).rejects.toThrow(/0644.*chmod 600/);
    expect(opts.readFile).not.toHaveBeenCalled();
  });

  it('fails without a TTY or KEYSTORE_PASSWORD_FILE, ignoring KEYSTORE_PASSWORD', async () => {
    const opts = sources({ env: { KEYSTORE_PASSWORD: 'unsupported' } });
    await expect(resolvePassword(opts)).rejects.toThrow(KeystoreError);
    await expect(resolvePassword(opts)).rejects.toThrow(/no password source/);
    expect(opts.prompt).not.toHaveBeenCalled();
  });
});
