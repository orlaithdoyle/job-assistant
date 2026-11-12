// Shared encryption helpers (browser and Node 20+). Uses only Web Crypto.
//
// Scheme: an RSA-OAEP key pair. The public key sits in the repo in the clear,
// so the daily search can ADD jobs without knowing the password. The private
// key is stored encrypted with a key derived from the password (PBKDF2), so
// only someone with the password can READ anything.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  from(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  to(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const RSA = { name: "RSA-OAEP", hash: "SHA-256" };
const PBKDF2_ITER = 310000;

export async function generateKeyPair() {
  const kp = await subtle.generateKey(
    { ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
    true, ["encrypt", "decrypt"]);
  return {
    publicJwk: await subtle.exportKey("jwk", kp.publicKey),
    privateJwk: await subtle.exportKey("jwk", kp.privateKey),
  };
}

export function importPublic(jwk) {
  return subtle.importKey("jwk", jwk, RSA, false, ["encrypt"]);
}
export function importPrivate(jwk) {
  return subtle.importKey("jwk", jwk, RSA, false, ["decrypt"]);
}

async function passwordKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Private key <-> password-locked blob
export async function lockPrivateKey(privateJwk, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(privateJwk)));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: PBKDF2_ITER, salt: b64.from(salt), iv: b64.from(iv), ct: b64.from(ct) };
}
export async function unlockPrivateKey(blob, password) {
  const key = await passwordKey(password, b64.to(blob.salt));
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64.to(blob.iv) }, key, b64.to(blob.ct));
  return JSON.parse(dec.decode(pt));
}

// Any JSON value <-> hybrid-encrypted blob (random AES key wrapped with RSA)
export async function seal(publicKey, value) {
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = await subtle.exportKey("raw", aes);
  const wrapped = await subtle.encrypt(RSA, publicKey, raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(value)));
  return { v: 1, k: b64.from(wrapped), iv: b64.from(iv), ct: b64.from(ct) };
}
export async function open(privateKey, blob) {
  const raw = await subtle.decrypt(RSA, privateKey, b64.to(blob.k));
  const aes = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64.to(blob.iv) }, aes, b64.to(blob.ct));
  return JSON.parse(dec.decode(pt));
}

// Stable, non-reversible fingerprint used to avoid adding the same job twice.
export async function jobFingerprint(org, role) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const digest = await subtle.digest("SHA-256", enc.encode(norm(org) + "|" + norm(role)));
  return b64.from(digest).slice(0, 24);
}
