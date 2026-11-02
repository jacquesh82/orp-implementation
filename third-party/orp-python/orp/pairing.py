"""Pairing: init and response codes, derivations, tokens (§7).

The HKDF info labels are frozen protocol values: they stay byte-identical
(French words included).
"""

from . import OrpError
from .encryption import hkdf

INIT_CODE_SIZE = 127
RESPONSE_CODE_SIZE = 85

INFO_DATA = b"ORP v0.1 donnees"
INFO_NONCE = b"ORP v0.1 nonce"
INFO_SAS = b"ORP v0.1 SAS"
INFO_PASSPHRASE = b"ORP v0.1 phrase"
INFO_SAS_SEED = b"ORP v0.1 graine SAS"


def init_code(session_id: bytes, pub: bytes, stream_size: int, digest: bytes,
              block_count: int, k_total: int, compressed: bool, by_passphrase: bool) -> bytes:
    if len(session_id) != 16 or len(pub) != 65 or len(digest) != 32:
        raise OrpError("code-appairage-invalide")
    flags = (0x01 if compressed else 0) | (0x02 if by_passphrase else 0)
    return (session_id + pub
            + (stream_size % (1 << 64)).to_bytes(8, "big") + digest
            + (block_count % (1 << 16)).to_bytes(2, "big") + (k_total % (1 << 16)).to_bytes(2, "big")
            + bytes([flags, 0x00]))


def response_code(session_id: bytes, pub: bytes, sas_seed: int) -> bytes:
    if len(session_id) != 16 or len(pub) != 65:
        raise OrpError("code-appairage-invalide")
    return session_id + pub + sas_seed.to_bytes(4, "big")


def read_init_code(code: bytes) -> dict:
    if len(code) != INIT_CODE_SIZE:
        raise OrpError("code-appairage-invalide")
    return {
        "session_id": code[0:16],
        "pub": code[16:81],
        "stream_size": int.from_bytes(code[81:89], "big"),
        "digest": code[89:121],
        "block_count": int.from_bytes(code[121:123], "big"),
        "k_total": int.from_bytes(code[123:125], "big"),
        "flags": code[125],
    }


def read_response_code(code: bytes) -> dict:
    if len(code) != RESPONSE_CODE_SIZE:
        raise OrpError("code-appairage-invalide")
    return {
        "session_id": code[0:16],
        "pub": code[16:81],
        "sas_seed": int.from_bytes(code[81:85], "big"),
    }


def token(session_id: bytes) -> int:
    """The first 4 bytes of the session_id, big-endian."""
    return int.from_bytes(session_id[:4], "big")


def keys(secret: bytes, session_id: bytes, sas_seed: int) -> tuple[bytes, bytes, int]:
    """(data key, nonce key, 6-digit SAS) — the salt of the keys is the session_id alone."""
    data_key = hkdf(secret, session_id, INFO_DATA, 32)
    nonce_key = hkdf(secret, session_id, INFO_NONCE, 32)
    sas_bytes = hkdf(secret, session_id + sas_seed.to_bytes(4, "big"), INFO_SAS, 4)
    return data_key, nonce_key, int.from_bytes(sas_bytes, "big") % 1_000_000


def passphrase_path(passphrase: str, session_id: bytes) -> tuple[bytes, int]:
    """(secret, sas_seed) — at least 8 UTF-8 bytes (the vectors count bytes)."""
    if len(passphrase.encode("utf-8")) < 8:
        raise OrpError("code-appairage-invalide")
    secret = hkdf(passphrase.encode("utf-8"), session_id, INFO_PASSPHRASE, 32)
    sas_seed = int.from_bytes(hkdf(secret, session_id, INFO_SAS_SEED, 4), "big")
    return secret, sas_seed
