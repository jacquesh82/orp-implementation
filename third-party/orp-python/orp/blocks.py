"""Splitting of the stream into symbols and blocks — §6.3 of the memo."""

SYMBOL_SIZE = 96
K_MAX = 1024


def plan(stream: bytes, symbol_size: int = SYMBOL_SIZE, k_max: int = K_MAX) -> tuple[list[int], list[list[bytes]]]:
    """(k_per_block, blocks) — the last symbol is padded with zeros."""
    s = -(-len(stream) // symbol_size) if stream else 0
    symbols = []
    for i in range(s):
        chunk = stream[i * symbol_size:(i + 1) * symbol_size]
        if len(chunk) < symbol_size:
            chunk = chunk + b"\x00" * (symbol_size - len(chunk))
        symbols.append(chunk)
    k_per_block = []
    blocks = []
    for b in range(-(-s // k_max) if s else 0):
        chunk = symbols[b * k_max:(b + 1) * k_max]
        k_per_block.append(len(chunk))
        blocks.append(chunk)
    return k_per_block, blocks
