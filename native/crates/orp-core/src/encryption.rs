//! End-to-end encryption (port of encryption.ts): ECDH P-256 key agreement,
//! HKDF-SHA-256 derivation, AES-GCM (128-bit tag), HMAC and SHA-256 — the
//! same primitives as WebCrypto, through the RustCrypto crates.
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
