import { hash, verify, Algorithm } from '@node-rs/argon2';

/** argon2id — memory-hard, and the current OWASP default for password storage. */
const OPTIONS = { algorithm: Algorithm.Argon2id } as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(passwordHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plaintext, OPTIONS);
  } catch {
    // A malformed or unparseable stored hash is a failed login, not a 500.
    return false;
  }
}
