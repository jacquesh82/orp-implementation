"""LT fountain code: robust soliton, neighbors, symbols, decoding by elimination (§6)."""

import math

from .primitives import mulberry32, real

C_PARAMETER = 0.1
DELTA = 0.5
SYMBOL_SIZE = 96


def robust_r(k: int) -> int:
    """R = max(1, round(c·√K·ln(K/δ))) — round half up, like Math.round."""
    if k < 2:
        return 1
    v = C_PARAMETER * math.sqrt(k) * math.log(k / DELTA)
    return max(1, math.floor(v + 0.5))


def _cdf(k: int) -> list[float]:
    r = robust_r(k)
    weights = []
    for i in range(1, k + 1):
        rho = 1.0 / k if i == 1 else 1.0 / (i * (i - 1))
        if i < r:
            tau = r / (i * k)
        elif i == r:
            tau = r * math.log(r / DELTA) / k
        else:
            tau = 0.0
        weights.append(rho + tau)
    z = sum(weights)
    cdf = []
    acc = 0.0
    for p in weights:
        acc += p / z
        cdf.append(acc)
    return cdf


def degree(k: int, draws) -> int:
    """First draw of the generator → degree through the CDF (u ≤ CDF(i))."""
    u = real(next(draws))
    cdf = _cdf(k)
    for i, bound in enumerate(cdf, start=1):
        if u <= bound:
            return i
    return k


def neighbors(k: int, seed: int) -> list[int]:
    """Partial Fisher-Yates shuffle: degree first, then d swap draws."""
    draws = mulberry32(seed)
    d = min(k, degree(k, draws))
    tab = list(range(k))
    for j in range(d):
        r = j + ((next(draws) * (k - j)) >> 32)
        tab[j], tab[r] = tab[r], tab[j]
    return tab[:d]


def symbol(sources: list[bytes], indices: list[int]) -> bytes:
    """Exclusive OR of the designated source symbols."""
    output = bytearray(SYMBOL_SIZE)
    for i in indices:
        src = sources[i]
        for o in range(SYMBOL_SIZE):
            output[o] ^= src[o]
    return bytes(output)


class Decoder:
    """Decodes a block of K symbols by elimination, completed by Gauss-Jordan (§6.8).

    Elimination alone can leave the block unfinished beyond the expected number of
    receptions; the memo allows (MAY) completing it with a Gauss-Jordan elimination
    over GF(2) once the pending combinations reach the number of unknowns — this is
    what the decoding vectors do.
    """

    def __init__(self, k: int):
        self.k = k
        self.known: dict[int, bytes] = {}
        self.pending: list[tuple[int, bytes, frozenset[int]]] = []
        self.seen_seeds: set[int] = set()
        self.complete = False

    def receive(self, seed: int, combination: bytes) -> tuple[bool, bool, int]:
        """(progress, complete, received) — progress = at least one symbol solved by this reception."""
        progress = False
        if seed not in self.seen_seeds:
            self.seen_seeds.add(seed)
            neigh = neighbors(self.k, seed)
            self.pending.append((seed, combination, frozenset(neigh)))
            progress = self._eliminate()
            progress = self._gauss_jordan() or progress
        self.complete = len(self.known) == self.k
        return progress, self.complete, len(self.seen_seeds)

    def _eliminate(self) -> bool:
        progress = False
        remaining = []
        for seed, combination, neigh in self.pending:
            unknowns = neigh - self.known.keys()
            if not unknowns:
                continue
            value = bytearray(combination)
            for i in neigh & self.known.keys():
                for o in range(SYMBOL_SIZE):
                    value[o] ^= self.known[i][o]
            if len(unknowns) == 1:
                i = next(iter(unknowns))
                self.known[i] = bytes(value)
                progress = True
            else:
                remaining.append((seed, bytes(value), frozenset(unknowns)))
        if progress:
            progress = self._eliminate() or progress
        else:
            self.pending = remaining
        return progress

    def _gauss_jordan(self) -> bool:
        """Solves the pending combinations if they cover the remaining unknowns."""
        unknowns = set(range(self.k)) - self.known.keys()
        if not unknowns or len(self.pending) < len(unknowns):
            return False
        pivots: dict[int, tuple[frozenset[int], bytes]] = {}
        for _seed, combination, neigh in self.pending:
            mask, value = set(neigh), bytearray(combination)
            for i in neigh & self.known.keys():
                for o in range(SYMBOL_SIZE):
                    value[o] ^= self.known[i][o]
            while mask:
                idx = min(mask)
                if idx in pivots:
                    pm, pv = pivots[idx]
                    mask ^= pm
                    for o in range(SYMBOL_SIZE):
                        value[o] ^= pv[o]
                else:
                    pivots[idx] = (frozenset(mask), bytes(value))
                    break
        if len(pivots) != len(unknowns):
            return False
        solutions: dict[int, bytes] = {}
        for idx in sorted(pivots, reverse=True):
            mask, value = pivots[idx]
            v = bytearray(value)
            for j in mask:
                if j != idx:
                    for o in range(SYMBOL_SIZE):
                        v[o] ^= solutions[j][o]
            solutions[idx] = bytes(v)
        self.known.update(solutions)
        self.pending = []
        return True

    def symbols(self) -> list[bytes]:
        return [self.known[i] for i in range(self.k)]
