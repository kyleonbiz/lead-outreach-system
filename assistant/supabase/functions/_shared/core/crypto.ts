// AES-256-GCM for OAuth credentials at rest + HMAC for signed OAuth state. WebCrypto only, so it runs
// identically in Node (tests) and Deno (edge functions). Keys never leave the server environment.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export const b64url = (u: Uint8Array): string => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64url = (s: string): Uint8Array<ArrayBuffer> => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))

export const randomUuid = (): string => crypto.randomUUID()

export class CryptoConfigError extends Error {}

function rawKey(keyB64: string): Uint8Array<ArrayBuffer> {
  let k: Uint8Array<ArrayBuffer>
  try { k = unb64(keyB64) } catch { throw new CryptoConfigError('TOKEN_ENCRYPTION_KEY is not valid base64') }
  if (k.length !== 32) throw new CryptoConfigError('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)')
  return k
}

async function aesKey(keyB64: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey(keyB64), 'AES-GCM', false, usage)
}

/** Format: v1.<iv>.<ciphertext+tag>. `aad` binds the ciphertext to its row so it can't be moved to another one. */
export async function encryptSecret(plaintext: string, keyB64: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(keyB64, ['encrypt']), enc.encode(plaintext)))
  return `v1.${b64url(iv)}.${b64url(ct)}`
}

export async function decryptSecret(payload: string, keyB64: string, aad: string): Promise<string> {
  const [v, iv, ct] = payload.split('.')
  if (v !== 'v1' || !iv || !ct) throw new Error('Unsupported ciphertext format')
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64url(iv), additionalData: enc.encode(aad) }, await aesKey(keyB64, ['decrypt']), unb64url(ct))
    return dec.decode(pt)
  } catch (e) {
    if (e instanceof CryptoConfigError) throw e
    throw new Error('Could not decrypt stored credentials (wrong key, tampered data, or wrong record)')
  }
}

async function hmacKey(keyB64: string): Promise<CryptoKey> {
  // domain-separated from the encryption use of the same secret
  const base = await crypto.subtle.importKey('raw', rawKey(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const derived = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('oauth-state-v1')))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
export interface OAuthStatePayload {
  org: string; user: string; provider: string; nonce: string; exp: number
}

export async function signState(p: OAuthStatePayload, keyB64: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(keyB64), enc.encode(body)))
  return `${body}.${b64url(sig)}`
}

/** Returns the payload only if the signature is valid and it has not expired. */
export async function verifyState(state: string, keyB64: string, nowMs: number): Promise<OAuthStatePayload | null> {
  const [body, sig] = state.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(keyB64), unb64url(sig), enc.encode(body))
    if (!ok) return null
    const p = JSON.parse(dec.decode(unb64url(body))) as OAuthStatePayload
    if (typeof p.exp !== 'number' || p.exp < nowMs) return null
    if (!p.org || !p.user || !p.provider) return null
    return p
  } catch { return null }
}
