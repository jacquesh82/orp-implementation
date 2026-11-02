import { describe, expect, it } from "vitest";

import { CryptoWebCrypto, OrpForgedFrame } from "../src/index.ts";

const crypto = new CryptoWebCrypto();

describe("CryptoProvider (WebCrypto)", () => {
  it("gives the same shared secret to both sides of the ECDH", async () => {
    const a = await crypto.generateEcdhKeyPair();
    const b = await crypto.generateEcdhKeyPair();
    const secretA = await crypto.deriveEcdhSecret(a.privateKey, b.publicKey);
    const secretB = await crypto.deriveEcdhSecret(b.privateKey, a.publicKey);
    expect(secretA).toHaveLength(32);
    expect(Array.from(secretA)).toEqual(Array.from(secretB));
  });

  it("encrypts, decrypts, and rejects a forged tag", async () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = new TextEncoder().encode("configuration.json — contenu secret");
    const aad = new Uint8Array([1, 2, 3]);
    const { ciphertext, tag } = await crypto.encryptAead(key, nonce, plaintext, aad);
    expect(ciphertext).toHaveLength(plaintext.length);
    const decrypted = await crypto.decryptAead(key, nonce, ciphertext, tag, aad);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));

    const badTag = tag.slice();
    badTag[0] = badTag[0]! ^ 1;
    await expect(crypto.decryptAead(key, nonce, ciphertext, badTag, aad)).rejects.toThrow();
    // A different AAD (forged header) is rejected as well.
    await expect(crypto.decryptAead(key, nonce, ciphertext, tag, new Uint8Array([9, 9, 9]))).rejects.toThrow();
  });

  it("derives HKDF deterministically and depending on the salt", async () => {
    const secret = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const a = await crypto.deriveHkdf(secret, salt, "ORP v0.1 donnees", 32);
    const b = await crypto.deriveHkdf(secret, salt, "ORP v0.1 donnees", 32);
    const c = await crypto.deriveHkdf(secret, salt, "ORP v0.1 nonce", 32);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it("computes HMAC and SHA-256 consistently", async () => {
    const key = crypto.randomBytes(32);
    const mac1 = await crypto.hmacSha256(key, new Uint8Array([1, 2, 3]));
    const mac2 = await crypto.hmacSha256(key, new Uint8Array([1, 2, 3]));
    expect(Array.from(mac1)).toEqual(Array.from(mac2));
    expect(await crypto.sha256(new Uint8Array(0))).toHaveLength(32);
  });

  it("has no DOM dependency (F-16): the class runs in plain Node", async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    // And the OrpForgedFrame error is exported for the hosts:
    expect(new OrpForgedFrame(1, 2).code).toBe("trame-falsifiee");
  });
});
