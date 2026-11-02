"""Reed-Solomon RS(255) over GF(256) — §5.3 of the memo.

Primitive polynomial 0x11D, α = 2, eight consecutive roots from α^0,
8 parity bytes, systematic code. At most 4 bytes corrected per segment;
beyond that, declared failure (the frame becomes an erasure for the fountain).
"""

POLY = 0x11D
ROOTS = 8
CORRECTION_MAX = 4

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= POLY
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _inv(a: int) -> int:
    return _EXP[255 - _LOG[a]]


def _poly_mul(p, q):
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        if a:
            la = _LOG[a]
            for j, b in enumerate(q):
                if b:
                    r[i + j] ^= _EXP[la + _LOG[b]]
    return r


def _poly_eval(p, x: int) -> int:
    """p[k] = coefficient of z^k; Horner evaluation from the highest degree."""
    y = 0
    for coef in reversed(p):
        y = _mul(y, x) ^ coef
    return y


_GENERATOR = [1]
for _i in range(ROOTS):
    _GENERATOR = _poly_mul(_GENERATOR, [1, _EXP[_i]])


def parity(data: bytes) -> bytes:
    """Systematic parity: remainder of (data · x⁸) divided by g(x)."""
    rest = [0] * ROOTS
    for byte in data:
        factor = byte ^ rest[0]
        rest = rest[1:] + [0]
        if factor:
            lf = _LOG[factor]
            for i, coef in enumerate(_GENERATOR[1:]):
                if coef:
                    rest[i] ^= _EXP[lf + _LOG[coef]]
    return bytes(rest)


def _syndromes(c) -> list[int]:
    """S_j = c(α^j), c(x) carrying byte i on x^(n−1−i)."""
    n = len(c)
    s = []
    for j in range(ROOTS):
        acc = 0
        for i, coef in enumerate(c):
            if coef:
                acc ^= _EXP[(_LOG[coef] + j * (n - 1 - i)) % 255]
        s.append(acc)
    return s


def correct(word: bytes) -> bytes | None:
    """Corrects at most 4 errors; None if the correction is impossible."""
    n = len(word)
    if n > 255 or n <= ROOTS:
        return None
    c = list(word)
    s = _syndromes(c)
    if not any(s):
        return bytes(word)

    # Berlekamp-Massey: Λ(z) = Σ C[k]·z^k, C[0] = 1
    C = [1]
    B = [1]
    L = 0
    m = 1
    b = 1
    for nn in range(ROOTS):
        d = s[nn]
        for i in range(1, min(L, len(C) - 1) + 1):
            d ^= _mul(C[i], s[nn - i])
        if d == 0:
            m += 1
            continue
        scale = _mul(d, _inv(b))
        previous = C[:]
        if len(C) < len(B) + m:
            C = C + [0] * (len(B) + m - len(C))
        for i, coef in enumerate(B):
            if coef:
                C[i + m] ^= _mul(scale, coef)
        if 2 * L <= nn:
            L = nn + 1 - L
            B = previous
            b = d
            m = 1
        else:
            m += 1
    deg = max(k for k, coef in enumerate(C) if coef) if any(C[1:]) else 0
    if L > CORRECTION_MAX or deg != L or L == 0:
        return None

    # Chien: positions i (0 = first byte) such that Λ(α^−i) = 0
    positions = []
    for i in range(n):
        if _poly_eval(C, _EXP[(-i) % 255]) == 0:
            positions.append(i)
    if len(positions) != L:
        return None

    # Forney: Ω(z) = S(z)·Λ(z) mod z⁸, Y = Ω(α^−i) / Λ′(α^−i)
    S_poly = s[:]  # S_poly[j] = coefficient of z^j
    omega = _poly_mul(S_poly, C)[:ROOTS]
    while len(omega) < ROOTS:
        omega.append(0)
    derivative = [0] * len(C)  # Λ′(z) = Σ_{k odd} C[k]·z^(k−1)
    for k in range(1, len(C), 2):
        derivative[k - 1] = C[k]
    for i in positions:
        xi = _EXP[(-i) % 255]
        num = _poly_eval(omega, xi)
        den = _poly_eval(derivative, xi)
        if den == 0:
            return None
        # syndromes S_j = c(α^j) (b = 0): the magnitude carries the factor X = α^i
        c[n - 1 - i] ^= _mul(_EXP[i % 255], _mul(num, _inv(den)))

    if any(_syndromes(c)):
        return None
    if sum(1 for a, b_ in zip(c, word) if a != b_) > CORRECTION_MAX:
        return None
    return bytes(c)
