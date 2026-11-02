/**
 * End-to-end encryption (§6): ECDH P-256 key agreement (audited standard
 * equivalent of X25519, universally available in WebCrypto), HKDF-SHA-256
 * derivation, AES-256-GCM authenticated encryption.
 *
 * Everything goes through the CryptoProvider interface: `core` depends on no
 * platform (rule 7.1-1), the browser adapter injects its own.
 */

import { OrpError } from "./errors.ts";

export interface EcdhKeyPair {
  privateKey: CryptoKey;
  /** Raw public key (uncompressed: 0x04 ‖ X ‖ Y, 65 bytes). */
  publicKey: Uint8Array;
}

export interface CryptoProvider {
  /** Cryptographically random bytes. */
  randomBytes(n: number): Uint8Array;
  generateEcdhKeyPair(): Promise<EcdhKeyPair>;
  /** 32-byte ECDH shared secret. */
  deriveEcdhSecret(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array>;
  deriveHkdf(secret: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array>;
  encryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }>;
  decryptAead(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new OrpError("crypto-indisponible", "WebCrypto unavailable on this platform");
  return c.subtle;
}

function randomBytes(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new OrpError("crypto-indisponible", "WebCrypto unavailable on this platform");
  return c.getRandomValues(new Uint8Array(n));
}

const RAW_PUBLIC_KEY_SIZE = 65;

/**
 * WebCrypto implementation — available in every modern browser and in
 * Node ≥ 20 (the `core` tests run on it, outside any browser).
 */
export class CryptoWebCrypto implements CryptoProvider {
  randomBytes(n: number): Uint8Array {
    return randomBytes(n);
  }

  async generateEcdhKeyPair(): Promise<EcdhKeyPair> {
    const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    // The public key must stay exportable to travel in the pairing code.
    const rawPublicKey = await subtle().exportKey("raw", pair.publicKey);
    if (rawPublicKey.byteLength !== RAW_PUBLIC_KEY_SIZE) {
      throw new OrpError("crypto-indisponible", "ECDH public key of unexpected size");
    }
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(rawPublicKey) };
  }

  async deriveEcdhSecret(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
    const pub = await subtle().importKey("raw", publicKey as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await subtle().deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
    return new Uint8Array(bits);
  }

  async deriveHkdf(secret: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
    const base = await subtle().importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
    const bits = await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(info) as BufferSource },
      base,
      length * 8,
    );
    return new Uint8Array(bits);
  }

  async encryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> {
    const k = await subtle().importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
    const output = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        k,
        plaintext as BufferSource,
      ),
    );
    const cut = output.length - INTERNAL_TAG_SIZE;
    return { ciphertext: output.slice(0, cut), tag: output.slice(cut) };
  }

  async decryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array> {
    const k = await subtle().importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const plaintext = await subtle().decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
      k,
      combined as BufferSource,
    );
    return new Uint8Array(plaintext);
  }

  async hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const k = await subtle().importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle().sign("HMAC", k, data as BufferSource));
  }

  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await subtle().digest("SHA-256", data as BufferSource));
  }
}

const INTERNAL_TAG_SIZE = 16;
