//! End-to-end encryption (port of encryption.ts): ECDH P-256 key agreement,
//! HKDF-SHA-256 derivation (PBKDF2-HMAC-SHA-256 for the pairing passphrase),
//! AES-GCM (128-bit tag), HMAC and SHA-256 — the same primitives as
//! WebCrypto, through the RustCrypto crates.
//!
//! Everything goes through the `CryptoProvider` trait; randomness is itself
//! injected (`RandomSource`): the system's in production, a reproducible
//! stream in tests.

use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce, Tag};
use hmac::{Hmac, Mac};
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};

use crate::random::{SystemRandom, RandomSource};
use crate::errors::OrpError;

/// Size of a raw uncompressed public key (0x04 ‖ X ‖ Y).
pub const RAW_PUB_SIZE: usize = 65;
/// Size of the AES-GCM tag.
pub const AEAD_TAG_SIZE: usize = 16;

/// Ephemeral ECDH private key — never exposed, never logged.
pub struct PrivateKey(SecretKey);

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClePrivee(…)")
    }
}

#[derive(Debug)]
pub struct EcdhPair {
    pub private_key: PrivateKey,
    /// Raw public key (uncompressed: 0x04 ‖ X ‖ Y, 65 bytes).
    pub public_key: [u8; RAW_PUB_SIZE],
}

impl EcdhPair {
    /// Key pair with the given private scalar (32 big-endian bytes);
    /// rejects 0 and values ≥ n.
    pub fn from_scalar(bytes: &[u8]) -> Result<Self, OrpError> {
        let key = SecretKey::from_slice(bytes).map_err(|_| crypto_error("invalid ECDH scalar"))?;
        let mut public_key = [0u8; RAW_PUB_SIZE];
        public_key.copy_from_slice(key.public_key().to_sec1_bytes().as_ref());
        Ok(Self { private_key: PrivateKey(key), public_key })
    }
}

/// 12-byte nonce (size already checked by the caller).
fn nonce_for(bytes: &[u8]) -> Nonce<U12> {
    Nonce::from(<[u8; 12]>::try_from(bytes).unwrap())
}

fn crypto_error(message: &str) -> OrpError {
    OrpError::generic("crypto", message)
}

/// The primitives `core` needs — a platform can provide its own.
pub trait CryptoProvider {
    /// Cryptographic random bytes.
    fn random_bytes(&mut self, n: usize) -> Vec<u8>;
    fn generate_ecdh_pair(&mut self) -> Result<EcdhPair, OrpError>;
    /// 32-byte ECDH shared secret (x coordinate, like deriveBits 256).
    fn ecdh_agree(&self, private_key: &PrivateKey, public_key: &[u8]) -> Result<[u8; 32], OrpError>;
    fn derive_hkdf(&self, secret: &[u8], salt: &[u8], info: &str, length: usize) -> Result<Vec<u8>, OrpError>;
    /// PBKDF2-HMAC-SHA-256 — stretching of the pairing passphrase (ORP v0.2).
    fn derive_pbkdf2(&self, password: &[u8], salt: &[u8], iterations: u32, length: usize) -> Result<Vec<u8>, OrpError>;
    /// AES-GCM: (ciphertext, 16-byte tag).
    fn encrypt_aead(&self, key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8])
        -> Result<(Vec<u8>, [u8; AEAD_TAG_SIZE]), OrpError>;
    fn decrypt_aead(&self, key: &[u8], nonce: &[u8], encrypted: &[u8], tag: &[u8], aad: &[u8])
        -> Result<Vec<u8>, OrpError>;
    fn hmac_sha256(&self, key: &[u8], data: &[u8]) -> [u8; 32];
    fn sha256(&self, data: &[u8]) -> [u8; 32];
}

/// RustCrypto implementation, with injectable randomness.
pub struct CryptoRust {
    random: Box<dyn RandomSource + Send>,
}

impl Default for CryptoRust {
    fn default() -> Self {
        Self::new()
    }
}

impl CryptoRust {
    /// System randomness (getrandom).
    pub fn new() -> Self {
        Self { random: Box::new(SystemRandom) }
    }

    /// Injected randomness — tests plug a reproducible stream into it.
    pub fn with_random(random: Box<dyn RandomSource + Send>) -> Self {
        Self { random }
    }
}

impl CryptoProvider for CryptoRust {
    fn random_bytes(&mut self, n: usize) -> Vec<u8> {
        let mut o = vec![0u8; n];
        self.random.fill(&mut o);
        o
    }

    /// The private scalar is drawn from the randomness (32 bytes), rejecting
    /// values outside [1, n−1] — probability ~2⁻³².
    fn generate_ecdh_pair(&mut self) -> Result<EcdhPair, OrpError> {
        loop {
            let d = self.random_bytes(32);
            if let Ok(p) = EcdhPair::from_scalar(&d) {
                return Ok(p);
            }
        }
    }

    fn ecdh_agree(&self, private_key: &PrivateKey, public_key: &[u8]) -> Result<[u8; 32], OrpError> {
        let public = PublicKey::from_sec1_bytes(public_key).map_err(|_| crypto_error("invalid ECDH public key"))?;
        let secret = p256::ecdh::diffie_hellman(private_key.0.to_nonzero_scalar(), public.as_affine());
        let mut o = [0u8; 32];
        o.copy_from_slice(secret.raw_secret_bytes());
        Ok(o)
    }

    fn derive_hkdf(&self, secret: &[u8], salt: &[u8], info: &str, length: usize) -> Result<Vec<u8>, OrpError> {
        let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), secret);
        let mut o = vec![0u8; length];
        hk.expand(info.as_bytes(), &mut o).map_err(|_| crypto_error("invalid HKDF length"))?;
        Ok(o)
    }

    fn derive_pbkdf2(&self, password: &[u8], salt: &[u8], iterations: u32, length: usize) -> Result<Vec<u8>, OrpError> {
        pbkdf2_hmac_sha256(password, salt, iterations, length)
    }

    fn encrypt_aead(
        &self,
        key: &[u8],
        nonce: &[u8],
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<(Vec<u8>, [u8; AEAD_TAG_SIZE]), OrpError> {
        if nonce.len() != 12 {
            return Err(crypto_error("AES-GCM nonce of unexpected size"));
        }
        let mut buffer = plaintext.to_vec();
        let n = &nonce_for(nonce);
        let tag = match key.len() {
            16 => Aes128Gcm::new_from_slice(key).unwrap().encrypt_in_place_detached(n, aad, &mut buffer),
            32 => Aes256Gcm::new_from_slice(key).unwrap().encrypt_in_place_detached(n, aad, &mut buffer),
            _ => return Err(crypto_error("AES-GCM key of unexpected size")),
        }
        .map_err(|_| crypto_error("AES-GCM encryption failed"))?;
        let mut t = [0u8; AEAD_TAG_SIZE];
        t.copy_from_slice(&tag);
        Ok((buffer, t))
    }

    fn decrypt_aead(
        &self,
        key: &[u8],
        nonce: &[u8],
        encrypted: &[u8],
        tag: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, OrpError> {
        if nonce.len() != 12 || tag.len() != AEAD_TAG_SIZE {
            return Err(crypto_error("AES-GCM nonce or tag of unexpected size"));
        }
        let mut buffer = encrypted.to_vec();
        let n = &nonce_for(nonce);
        let t = &Tag::from(<[u8; AEAD_TAG_SIZE]>::try_from(tag).unwrap());
        match key.len() {
            16 => Aes128Gcm::new_from_slice(key).unwrap().decrypt_in_place_detached(n, aad, &mut buffer, t),
            32 => Aes256Gcm::new_from_slice(key).unwrap().decrypt_in_place_detached(n, aad, &mut buffer, t),
            _ => return Err(crypto_error("AES-GCM key of unexpected size")),
        }
        .map_err(|_| crypto_error("AES-GCM authentication failed"))?;
        Ok(buffer)
    }

    fn hmac_sha256(&self, key: &[u8], data: &[u8]) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
        mac.update(data);
        mac.finalize().into_bytes().into()
    }

    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }
}

/// SHA-256 initial state (FIPS 180-4, §5.3.3).
const SHA256_IV: [u32; 8] =
    [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/// One SHA-256 compression of a 64-byte block, from the given state.
fn compress_block(state: &[u32; 8], block: &[u8; 64]) -> [u32; 8] {
    let mut s = *state;
    sha2::compress256(&mut s, &[(*block).into()]);
    s
}

/// PBKDF2-HMAC-SHA-256 (RFC 8018 §5.2), like WebCrypto `deriveBits`.
///
/// No `pbkdf2` crate: written over the SHA-256 compression function. The
/// inner and outer HMAC states (key ⊕ ipad, key ⊕ opad) are computed once;
/// each of the 600 000 iterations then costs exactly two compressions — the
/// whole derivation stays well under a second on a phone, and in debug tests.
pub fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32, length: usize) -> Result<Vec<u8>, OrpError> {
    if iterations == 0 || length == 0 || length as u64 > 32 * u32::MAX as u64 {
        return Err(crypto_error("invalid PBKDF2 parameters"));
    }
    // HMAC key: hashed if longer than the SHA-256 block.
    let mut key = [0u8; 64];
    if password.len() > 64 {
        key[..32].copy_from_slice(&Sha256::digest(password));
    } else {
        key[..password.len()].copy_from_slice(password);
    }
    let pad_state = |pad: u8| {
        let mut block = [0u8; 64];
        for (b, k) in block.iter_mut().zip(&key) {
            *b = k ^ pad;
        }
        let state = compress_block(&SHA256_IV, &block);
        wipe(&mut block);
        state
    };
    let (inner, outer) = (pad_state(0x36), pad_state(0x5c));
    wipe(&mut key);
    let prf = <Hmac<Sha256> as Mac>::new_from_slice(password).expect("HMAC accepts any key length");
    // A 32-byte message after the 64-byte pad block: 96 bytes = 768 bits,
    // padding 0x80 then the length — one block.
    let mut block = [0u8; 64];
    block[32] = 0x80;
    block[62..64].copy_from_slice(&768u16.to_be_bytes());
    let state_bytes = |state: [u32; 8], into: &mut [u8]| {
        for (o, w) in into.chunks_exact_mut(4).zip(state) {
            o.copy_from_slice(&w.to_be_bytes());
        }
    };
    let mut output = Vec::with_capacity(length);
    let mut index: u32 = 1;
    while output.len() < length {
        // U1 = HMAC(P, S ‖ INT(i)): salt of any length, through the hmac crate.
        let mut mac = prf.clone();
        mac.update(salt);
        mac.update(&index.to_be_bytes());
        let mut u: [u8; 32] = mac.finalize().into_bytes().into();
        let mut t = u;
        for _ in 1..iterations {
            block[..32].copy_from_slice(&u);
            state_bytes(compress_block(&inner, &block), &mut block[..32]);
            state_bytes(compress_block(&outer, &block), &mut u);
            for (a, b) in t.iter_mut().zip(&u) {
                *a ^= b;
            }
        }
        let n = (length - output.len()).min(32);
        output.extend_from_slice(&t[..n]);
        wipe(&mut u);
        wipe(&mut t);
        index += 1;
    }
    wipe(&mut block);
    Ok(output)
}

/// Wipes a buffer — volatile writes: the optimizer cannot remove them.
pub fn wipe(buffer: &mut [u8]) {
    for o in buffer.iter_mut() {
        unsafe { std::ptr::write_volatile(o, 0) };
    }
}
