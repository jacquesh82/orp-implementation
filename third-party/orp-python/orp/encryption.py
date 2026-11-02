"""Session cryptographic primitives — §6.7 and §7.4 of the memo.

ECDH P-256, HKDF-SHA-256, AES-256-GCM, HMAC-SHA-256, SHA-256. The nonce of a
frame is deterministic: the HMAC-SHA-256 of the nonce key over
(block u32 ‖ seed u32), big-endian, truncated to 12 bytes.
"""

import hashlib
import hmac as hmac_mod

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CURVE = ec.SECP256R1()


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return hmac_mod.new(key, data, hashlib.sha256).digest()


def hkdf(secret: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(secret)


def key_pair_from_scalar(scalar: bytes) -> tuple[object, bytes]:
    """(private key, uncompressed point 0x04 ‖ X ‖ Y) from a 32-byte scalar."""
    key = ec.derive_private_key(int.from_bytes(scalar, "big"), CURVE)
    point = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962, format=serialization.PublicFormat.UncompressedPoint
    )
    return key, point


def shared_secret(private_key, peer_point: bytes) -> bytes:
    pub = ec.EllipticCurvePublicKey.from_encoded_point(CURVE, peer_point)
    return private_key.exchange(ec.ECDH(), pub)


def aead_encrypt(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes]:
    output = AESGCM(key).encrypt(nonce, plaintext, aad if aad else None)
    return output[:-16], output[-16:]


def aead_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes, aad: bytes) -> bytes | None:
    try:
        return AESGCM(key).decrypt(nonce, ciphertext + tag, aad if aad else None)
    except Exception:
        return None


def frame_nonce(nonce_key: bytes, block: int, seed: int) -> bytes:
    return hmac_sha256(nonce_key, block.to_bytes(4, "big") + seed.to_bytes(4, "big"))[:12]
