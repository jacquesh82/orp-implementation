"""Basic primitives: IEEE 802.3 CRC-32 and the mulberry32 PRNG (§5.2, §6.4 of the memo)."""

M32 = 0xFFFFFFFF


def crc32(data: bytes) -> int:
    """CRC-32/ISO-HDLC: reflected polynomial 0xEDB88320, init and final XOR 0xFFFFFFFF."""
    crc = M32
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
    return crc ^ M32


def mulberry32(seed: int):
    """Generator (iterator) yielding the exact u32 NUMERATORS: draw = n / 2³².

    The memo returns ((t ⊕ (t ≫ 14)) mod 2³²) / 2³²; keeping the integer avoids
    any loss of precision and reproduces exactly the IEEE floats of the
    reference (same quotient, same rounding).
    """
    state = seed & M32
    while True:
        state = (state + 0x6D2B79F5) & M32
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & M32
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & M32)) & M32) ^ t
        yield (t ^ (t >> 14)) & M32


def real(draw: int) -> float:
    """The [0, 1[ float of a numerator — same IEEE division as the reference."""
    return draw / 4294967296


def prng_bytes(seed: int, n: int) -> bytes:
    """n pseudo-random bytes: each byte is ⌊draw × 256⌋ (§10.3.3 of the guide)."""
    g = mulberry32(seed)
    return bytes((next(g) * 256) >> 32 for _ in range(n))
