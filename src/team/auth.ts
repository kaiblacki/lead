import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Passwort-Hash (scrypt, Salz je Benutzer). Nie das Passwort selbst speichern oder ausgeben. */
export function hashPassword(pw: string): string {
  if (pw.length < 8) throw new Error('Das Passwort muss mindestens 8 Zeichen haben.');
  if (pw.length > 200) throw new Error('Das Passwort ist zu lang.');
  const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$'); if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex'); const got = scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}
export const normLogin = (s: string) => s.trim().toLowerCase();
