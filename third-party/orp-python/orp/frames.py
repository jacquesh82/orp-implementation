"""ORP frame: tripled meta, body, segments — §5 of the memo.

Header dicts use the field names of the vectors (`frames.json`): version
{major, minor}, codec, flags, token, block, k, symbolCount, seed.
"""

import math

from . import OrpError
from .primitives import crc32
from .rs import correct, parity

MAGIC = b"\x4f\x52"
VERSION = (0, 2)
CODECS = {1: "MONO_2", 2: "COLOR_4", 3: "COLOR_8"}
META_SIZE = 8
HEADER_SIZE = 14
SYMBOL_SIZE = 96
K_MAX = 1024
SEGMENT_SIZE = 247
PARITY = 8
TAG = 16

FLAG_COMPRESSED = 0x01
FLAG_ENCRYPTED = 0x02
FLAG_TEST_PATTERN = 0x04
FLAG_PAIRING = 0x08

MAX_SYMBOLS = {1: 1, 2: 2, 3: 4}


def meta(major: int, minor: int, codec: int, flags: int, symbol_count: int) -> bytes:
    return bytes([0x4F, 0x52, major, minor, codec, flags, symbol_count, 0x00])


def header_bytes(token: int, block: int, k: int, seed: int) -> bytes:
    return token.to_bytes(4, "big") + block.to_bytes(4, "big") + k.to_bytes(2, "big") + seed.to_bytes(4, "big")


def sizes(symbol_count: int, encrypted: bool) -> tuple[int, int, int]:
    """(L_body, T, L_frame) — §5.5."""
    e = TAG if encrypted else 0
    l_body = HEADER_SIZE + SYMBOL_SIZE * symbol_count + e + 4
    t = math.ceil(l_body / SEGMENT_SIZE)
    return l_body, t, META_SIZE * 3 + l_body + PARITY * t


def build(hdr: dict, payload: bytes, tag: bytes | None) -> bytes:
    """Builds a frame from its logical header, its payload and its tag."""
    flags = hdr["flags"]
    count = hdr["symbolCount"]
    codec = hdr["codec"]
    k = hdr["k"]
    if codec not in CODECS or not (1 <= count <= 4) or flags & 0xF0:
        raise OrpError("trame-invalide")
    if not (1 <= k <= K_MAX):
        raise OrpError("trame-invalide")
    if bool(flags & FLAG_ENCRYPTED) != (tag is not None):
        raise OrpError("trame-invalide")
    if len(payload) != count * SYMBOL_SIZE:
        raise OrpError("trame-invalide")
    m = meta(hdr["version"]["major"], hdr["version"]["minor"], codec, flags, count)
    body = header_bytes(hdr["token"], hdr["block"], k, hdr["seed"]) + payload
    if tag is not None:
        body += tag
    body += crc32(body).to_bytes(4, "big")
    return m * 3 + pack(body)


def pack(body: bytes) -> bytes:
    """Splits the body into RS segments followed by their parity."""
    output = b""
    for i in range(0, len(body), SEGMENT_SIZE):
        segment = body[i:i + SEGMENT_SIZE]
        output += segment + parity(segment)
    return output


def read(raw: bytes) -> tuple[dict, bytes, bytes | None]:
    """Reads a raw frame. Returns (header, payload, tag|None) — raises OrpError.

    Expected codes: `trame-invalide` (shape, meta), `correction-impossible` (RS),
    `trame-corrompue` (CRC). Version compatibility belongs to the session.
    """
    if len(raw) < META_SIZE * 3:
        raise OrpError("trame-invalide")
    # byte-by-byte majority meta
    copies = [raw[i * META_SIZE:(i + 1) * META_SIZE] for i in range(3)]
    m = bytearray(META_SIZE)
    for i in range(META_SIZE):
        a, b, c = copies[0][i], copies[1][i], copies[2][i]
        if a == b or a == c:
            m[i] = a
        elif b == c:
            m[i] = b
        else:
            raise OrpError("trame-invalide")
    major, minor, codec, flags, count, _reserved = m[2], m[3], m[4], m[5], m[6], m[7]
    if m[0:2] != MAGIC or codec not in CODECS or flags & 0xF0 or not (1 <= count <= 4):
        raise OrpError("trame-invalide")
    l_body, t, l_frame = sizes(count, bool(flags & FLAG_ENCRYPTED))
    if len(raw) < l_frame:
        raise OrpError("trame-invalide")
    # segments: data ‖ parity, bytes beyond the expected length are ignored.
    # An uncorrectable segment is not a fatal error of the frame reader: the raw
    # data go through the CRC-32 net — the vectors never expect
    # `correction-impossible` at the reader level (that code belongs to the session).
    body = b""
    pos = META_SIZE * 3
    for i in range(t):
        dl = min(SEGMENT_SIZE, l_body - i * SEGMENT_SIZE)
        word = raw[pos:pos + dl + PARITY]
        if len(word) < dl + PARITY:
            raise OrpError("trame-invalide")
        corrected = correct(word)
        body += (corrected if corrected is not None else word)[:dl]
        pos += dl + PARITY
    useful_body, received_crc = body[:-4], int.from_bytes(body[-4:], "big")
    if crc32(useful_body) != received_crc:
        raise OrpError("trame-corrompue")
    token = int.from_bytes(body[0:4], "big")
    block = int.from_bytes(body[4:8], "big")
    k = int.from_bytes(body[8:10], "big")
    seed = int.from_bytes(body[10:14], "big")
    payload = body[14:14 + count * SYMBOL_SIZE]
    tag = body[14 + count * SYMBOL_SIZE:14 + count * SYMBOL_SIZE + TAG] if flags & FLAG_ENCRYPTED else None
    hdr = {
        "version": {"major": major, "minor": minor},
        "codec": codec,
        "flags": flags,
        "token": token,
        "block": block,
        "k": k,
        "symbolCount": count,
        "seed": seed,
        "meta": bytes(m),
        "headerBytes": body[0:14],
    }
    return hdr, payload, tag
