"""deflate-raw compression (RFC 1951, without the zlib wrapper) — §6.2 of the memo.

The round trip is the interoperability criterion; the exact representation of
the output MAY differ from the one of the reference platform. Without a gain
(or with an empty input), the sender goes uncompressed (None).
"""

import zlib


def compress(stream: bytes) -> bytes | None:
    if not stream:
        return None
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    output = compressor.compress(stream) + compressor.flush()
    return output if len(output) < len(stream) else None


def decompress(stream: bytes) -> bytes:
    decompressor = zlib.decompressobj(-15)
    return decompressor.decompress(stream) + decompressor.flush()
