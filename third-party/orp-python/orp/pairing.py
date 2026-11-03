"""Pairing (ORP v0.2): init, response and reveal codes, transcript, derivations, tokens (§7).

Every code starts with a kind byte ("I" 0x49, "R" 0x52, "V" 0x56) and a version
byte (major << 4 | minor = 0x02). The init code carries a COMMITMENT to the
sender's public key; the key itself comes in the reveal code. Keys and SAS are
derived with salt = transcript hash of the codes exchanged. The labels are
frozen protocol values: they stay byte-identical (French words included).
"""

import hashlib
import hmac as hmac_mod

from . import OrpError
from .encryption import hkdf, sha256

KIND_INIT = 0x49
KIND_RESPONSE = 0x52
KIND_REVEAL = 0x56
CODE_VERSION = 0x02

INIT_CODE_SIZE = 97
RESPONSE_CODE_SIZE = 83
REVEAL_CODE_SIZE = 83

FLAG_COMPRESSED = 0x01
FLAG_BY_PASSPHRASE = 0x02
FLAG_ENCRYPTED = 0x04

SYMBOL_SIZE = 96
K_MAX = 1024
MAX_STREAM_SIZE = (1 << 53) - 1
PASSPHRASE_ITERATIONS = 600_000

LABEL_COMMITMENT = b"ORP v0.2 engagement"
LABEL_TRANSCRIPT = b"ORP v0.2 transcription"
LABEL_PASSPHRASE = b"ORP v0.2 phrase"
INFO_DATA = b"ORP v0.2 donnees"
INFO_NONCE = b"ORP v0.2 nonce"
INFO_SAS = b"ORP v0.2 SAS"


def expected_layout(stream_size: int) -> tuple[int, int]:
    """(block count, total K) implied by the stream size."""
    k_total = -(-stream_size // SYMBOL_SIZE)
    return -(-k_total // K_MAX), k_total


def expected_k(stream_size: int, block: int) -> int:
    """K of a block, 0 if the block does not exist."""
    count, k_total = expected_layout(stream_size)
    if block < 0 or block >= count:
        return 0
    return min(K_MAX, k_total - block * K_MAX)


def commitment(session_id: bytes, sender_pub: bytes) -> bytes:
    return sha256(LABEL_COMMITMENT + session_id + sender_pub)


def init_code(session_id: bytes, commit: bytes, stream_size: int, digest: bytes,
              block_count: int, k_total: int, compressed: bool, by_passphrase: bool,
              encrypted: bool) -> bytes:
    if len(session_id) != 16 or len(commit) != 32 or len(digest) != 32:
        raise OrpError("code-appairage-invalide")
    if not 0 <= stream_size <= MAX_STREAM_SIZE or (block_count, k_total) != expected_layout(stream_size) \
            or block_count > 0xFFFF:
        raise OrpError("code-appairage-invalide")
    flags = (FLAG_COMPRESSED if compressed else 0) | (FLAG_BY_PASSPHRASE if by_passphrase else 0) \
        | (FLAG_ENCRYPTED if encrypted else 0)
    return (bytes([KIND_INIT, CODE_VERSION]) + session_id + commit
            + stream_size.to_bytes(8, "big") + digest
            + block_count.to_bytes(2, "big") + k_total.to_bytes(4, "big") + bytes([flags]))


def _key_code(kind: int, session_id: bytes, pub: bytes) -> bytes:
    if len(session_id) != 16 or len(pub) != 65:
        raise OrpError("code-appairage-invalide")
    return bytes([kind, CODE_VERSION]) + session_id + pub


def response_code(session_id: bytes, receiver_pub: bytes) -> bytes:
    return _key_code(KIND_RESPONSE, session_id, receiver_pub)


def reveal_code(session_id: bytes, sender_pub: bytes) -> bytes:
    return _key_code(KIND_REVEAL, session_id, sender_pub)


def _check_header(code: bytes, kind: int, size: int) -> None:
    if len(code) != size or code[0] != kind:
        raise OrpError("code-appairage-invalide")
    if code[1] != CODE_VERSION:
        raise OrpError("version-incompatible")


def read_init_code(code: bytes) -> dict:
    _check_header(code, KIND_INIT, INIT_CODE_SIZE)
    stream_size = int.from_bytes(code[50:58], "big")
    block_count = int.from_bytes(code[90:92], "big")
    k_total = int.from_bytes(code[92:96], "big")
    flags = code[96]
    if stream_size > MAX_STREAM_SIZE or (block_count, k_total) != expected_layout(stream_size) \
            or flags & ~(FLAG_COMPRESSED | FLAG_BY_PASSPHRASE | FLAG_ENCRYPTED):
        raise OrpError("code-appairage-invalide")
    return {
        "session_id": code[2:18],
        "commitment": code[18:50],
        "stream_size": stream_size,
        "digest": code[58:90],
        "block_count": block_count,
        "k_total": k_total,
        "flags": flags,
    }


def read_response_code(code: bytes) -> dict:
    _check_header(code, KIND_RESPONSE, RESPONSE_CODE_SIZE)
    return {"session_id": code[2:18], "pub": code[18:83]}


def read_reveal_code(code: bytes) -> dict:
    _check_header(code, KIND_REVEAL, REVEAL_CODE_SIZE)
    return {"session_id": code[2:18], "pub": code[18:83]}


def opens_commitment(session_id: bytes, sender_pub: bytes, commit: bytes) -> bool:
    return hmac_mod.compare_digest(commitment(session_id, sender_pub), commit)


def token(session_id: bytes) -> int:
    """The first 4 bytes of the session_id, big-endian."""
    return int.from_bytes(session_id[:4], "big")


def transcript(init: bytes, response: bytes = b"", reveal: bytes = b"") -> bytes:
    """SHA-256(label ‖ init ‖ response ‖ reveal) — init alone on the passphrase path."""
    return sha256(LABEL_TRANSCRIPT + init + response + reveal)


def keys(secret: bytes, th: bytes) -> tuple[bytes, bytes, int]:
    """(data key, nonce key, 6-digit SAS) — HKDF salt = transcript hash."""
    data_key = hkdf(secret, th, INFO_DATA, 32)
    nonce_key = hkdf(secret, th, INFO_NONCE, 32)
    sas_bytes = hkdf(secret, th, INFO_SAS, 4)
    return data_key, nonce_key, int.from_bytes(sas_bytes, "big") % 1_000_000


def passphrase_secret(passphrase: str, session_id: bytes) -> bytes:
    """PBKDF2-HMAC-SHA-256, 600 000 iterations — at least 8 UTF-16 code units."""
    if len(passphrase.encode("utf-16-le")) // 2 < 8:
        raise OrpError("code-appairage-invalide")
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), LABEL_PASSPHRASE + session_id,
                               PASSPHRASE_ITERATIONS, 32)


def passphrase_keys(passphrase: str, init: bytes) -> tuple[bytes, bytes, int]:
    """Passphrase path: keys bound to the init code (transcript of the init alone)."""
    secret = passphrase_secret(passphrase, read_init_code(init)["session_id"])
    return keys(secret, transcript(init))
