// Encrypt a value for a GitHub Actions secret.
//
// GitHub's "create or update a repository secret" API wants the value sealed with
// libsodium's crypto_box_seal against the repo's Actions public key. tweetnacl +
// tweetnacl-sealedbox-js are pure JS; the only native bit is the CSPRNG for the
// ephemeral key, which we take from expo-crypto.
import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';
import * as Crypto from 'expo-crypto';

// tweetnacl needs a PRNG in React Native (Hermes has no global crypto).
nacl.setPRNG((x, n) => {
  const b = Crypto.getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = b[i];
});

function b64ToBytes(b64) {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa(bin);
}
function strToBytes(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

// publicKeyB64: the `key` field from GET /repos/{o}/{r}/actions/secrets/public-key
// Returns the base64 ciphertext to send as `encrypted_value`.
export function encryptSecret(publicKeyB64, secretValue) {
  const pk = b64ToBytes(publicKeyB64);
  const sealed = sealedbox.seal(strToBytes(secretValue), pk);
  return bytesToB64(sealed);
}
