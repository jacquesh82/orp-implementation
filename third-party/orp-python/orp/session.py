"""Transfer session: sender and receiver — §6.6, §6.8, §7 of the memo (ORP v0.2).

All the randomness comes from the mulberry32 stream (distinct sender/receiver
seeds): session_id then ECDH scalar for the sender; scalar for the receiver on
the strong path (init → response → reveal). The fountain seed counter starts at
1 and advances by symbol_count per frame.

The reception statuses are those of the vectors: "accepted", or the frozen
rejection reasons (corrompue, invalide, falsifiee, rejeu).
"""

from . import OrpError
from .blocks import plan
from .compression import decompress
from .encryption import aead_decrypt, aead_encrypt, frame_nonce, key_pair_from_scalar, shared_secret, sha256
from .fountain import Decoder, neighbors, symbol
from .frames import FLAG_COMPRESSED, FLAG_ENCRYPTED, MAX_SYMBOLS, VERSION, build, header_bytes, meta, read
from .pairing import (FLAG_BY_PASSPHRASE, FLAG_COMPRESSED as INIT_COMPRESSED, FLAG_ENCRYPTED as INIT_ENCRYPTED,
                      commitment, expected_k, init_code, keys, opens_commitment, passphrase_keys,
                      read_init_code, read_response_code, read_reveal_code, response_code, reveal_code,
                      token, transcript)
from .primitives import mulberry32


def _bytes(draws, n: int) -> bytes:
    return bytes((next(draws) * 256) >> 32 for _ in range(n))


class Sender:
    def __init__(self, seed: int, codecs: list[int], fallback: dict | None = None, encrypt: bool = True):
        draws = mulberry32(seed)
        self.session_id = _bytes(draws, 16)
        self.private_key, self.point = key_pair_from_scalar(_bytes(draws, 32))
        self.codecs = codecs
        self.fallback = fallback
        self.encrypt = encrypt  # session policy: CHIFFRE flag on the data frames
        self.counter = 1
        self.sent_frames: list[bytes] = []
        self.code = b""
        self.blocks: list[list[bytes]] = []
        self.k_per_block: list[int] = []
        self.data_key = b""
        self.nonce_key = b""
        self.sas = 0
        self.reveal = b""

    def prepare(self, stream: bytes, compressed: bool, by_passphrase: bool) -> None:
        """State prepare → pairing: compression done, splitting, init code (commitment, flags)."""
        self.stream = stream
        self.compressed = compressed
        digest = sha256(stream)
        self.k_per_block, self.blocks = plan(stream)
        self.code = init_code(self.session_id, commitment(self.session_id, self.point), len(stream), digest,
                              len(self.blocks), sum(self.k_per_block), compressed, by_passphrase,
                              self.encrypt)

    def accept_response(self, code: bytes) -> int:
        """Strong path: reads the response code, derives the keys, prepares the reveal code."""
        decoded = read_response_code(code)
        if decoded["session_id"] != self.session_id:
            raise OrpError("code-appairage-invalide")
        self.reveal = reveal_code(self.session_id, self.point)
        secret = shared_secret(self.private_key, decoded["pub"])
        self.data_key, self.nonce_key, self.sas = keys(secret, transcript(self.code, code, self.reveal))
        return self.sas

    def accept_passphrase(self, passphrase: str) -> int:
        """Passphrase path: PBKDF2 secret, keys bound to the init code."""
        self.data_key, self.nonce_key, self.sas = passphrase_keys(passphrase, self.code)
        return self.sas

    def _codec(self, index: int) -> int:
        if self.fallback is not None and index >= self.fallback["after"]:
            return self.fallback["codec"]
        return self.codecs[0]

    def send(self, passes: int) -> list[bytes]:
        """Sending loop: round-robin per frame, budget of K symbols per block and per pass."""
        output = []
        encrypted = self.encrypt
        for _ in range(passes):
            remaining = list(self.k_per_block)
            while any(remaining):
                index = len(self.sent_frames)
                codec = self._codec(index)
                count_max = MAX_SYMBOLS[codec]
                active = [b for b, r in enumerate(remaining) if r > 0]
                b = active[index % len(active)] if len(active) > 1 else active[0]
                count = min(count_max, remaining[b])
                seed = self.counter & 0xFFFFFFFF
                sources = self.blocks[b]
                payload = b"".join(symbol(sources, neighbors(len(sources), (seed + i) & 0xFFFFFFFF))
                                   for i in range(count))
                flags = (FLAG_ENCRYPTED if encrypted else 0) | (FLAG_COMPRESSED if self.compressed else 0)
                hdr = {"version": {"major": VERSION[0], "minor": VERSION[1]}, "codec": codec,
                       "flags": flags, "token": token(self.session_id), "block": b,
                       "k": len(sources), "symbolCount": count, "seed": seed}
                if encrypted:
                    m = meta(VERSION[0], VERSION[1], codec, flags, count)
                    head = header_bytes(hdr["token"], hdr["block"], hdr["k"], hdr["seed"])
                    nonce = frame_nonce(self.nonce_key, hdr["block"], hdr["seed"])
                    ciphertext, tag = aead_encrypt(self.data_key, nonce, payload, m + head)
                    output.append(build(hdr, ciphertext, tag))
                else:
                    output.append(build(hdr, payload, None))
                self.counter = (self.counter + count) & 0xFFFFFFFF
                remaining[b] -= count
                self.sent_frames.append(output[-1])
        return output


class Receiver:
    def __init__(self, seed: int | None = None, accept_clear: bool = False):
        self.private_key = None
        self.point = b""
        if seed is not None:
            draws = mulberry32(seed)
            self.private_key, self.point = key_pair_from_scalar(_bytes(draws, 32))
        self.accept_clear = accept_clear
        self.code = b""
        self.response = b""
        self.session_id = b""
        self.token = 0
        self.stream_size = 0
        self.digest = b""
        self.block_count = 0
        self.k_total = 0
        self.compressed = False
        self.by_passphrase = False
        self.data_key = b""
        self.nonce_key = b""
        self.sas = 0
        self.decoders: dict[int, Decoder] = {}
        self.seen_seeds: set[tuple[int, int]] = set()
        # Same keys as the "progress" object of sessions.json.
        self.progress = {"completedBlocks": 0, "blockCount": 0, "receivedSymbols": 0, "receivedFrames": 0,
                         "replays": 0, "forged": 0, "corrupted": 0}
        self.result: bytes | None = None
        self.errors: list[str] = []

    def accept_init(self, code: bytes) -> None:
        """Reads the init code and records the announcement (without deriving the keys).
        A sender announcing clear frames is refused unless accepted explicitly."""
        decoded = read_init_code(code)
        self.encrypted = bool(decoded["flags"] & INIT_ENCRYPTED)
        if not self.encrypted and not self.accept_clear:
            raise OrpError("code-appairage-invalide")
        self.code = code
        self.session_id = decoded["session_id"]
        self.token = token(decoded["session_id"])
        self.stream_size = decoded["stream_size"]
        self.digest = decoded["digest"]
        self.block_count = decoded["block_count"]
        self.k_total = decoded["k_total"]
        self.compressed = bool(decoded["flags"] & INIT_COMPRESSED)
        self.by_passphrase = bool(decoded["flags"] & FLAG_BY_PASSPHRASE)
        self.commitment = decoded["commitment"]
        self.progress["blockCount"] = self.block_count

    def produce_response(self) -> bytes:
        """Strong path, step 2: the response code — no key, no SAS yet."""
        if self.by_passphrase:
            raise OrpError("etat-invalide")
        self.response = response_code(self.session_id, self.point)
        return self.response

    def accept_reveal(self, code: bytes) -> int:
        """Strong path, step 3: the reveal code must open the commitment of the init code."""
        decoded = read_reveal_code(code)
        if decoded["session_id"] != self.session_id or not opens_commitment(
                self.session_id, decoded["pub"], self.commitment):
            raise OrpError("code-appairage-invalide")
        secret = shared_secret(self.private_key, decoded["pub"])
        self.data_key, self.nonce_key, self.sas = keys(secret, transcript(self.code, self.response, code))
        return self.sas

    def pair_passphrase(self, passphrase: str) -> int:
        if not self.by_passphrase:
            raise OrpError("etat-invalide")
        self.data_key, self.nonce_key, self.sas = passphrase_keys(passphrase, self.code)
        return self.sas

    def receive(self, raw: bytes) -> str | None:
        """Processes a received frame; returns the status in the vocabulary of the vectors."""
        try:
            hdr, payload, tag = read(raw)
        except OrpError as e:
            if e.code in ("correction-impossible", "trame-corrompue"):
                self.progress["corrupted"] += 1
                return "corrompue"
            self.errors.append(e.code)
            return "invalide"
        major, minor = hdr["version"]["major"], hdr["version"]["minor"]
        if major != VERSION[0] or minor > VERSION[1]:
            self.errors.append("version-incompatible")
            return "invalide"
        if hdr["flags"] & 0x0C:  # MIRE or APPAIRAGE: outside the data session
            return None
        if hdr["token"] != self.token:
            self.errors.append("session-inconnue")
            return "invalide"
        # v0.2: frame outside the announced layout, then encryption other than announced.
        if hdr["k"] != expected_k(self.stream_size, hdr["block"]):
            return "invalide"
        if bool(hdr["flags"] & FLAG_ENCRYPTED) != self.encrypted:
            self.progress["forged"] += 1
            return "falsifiee"
        key = (hdr["block"], hdr["seed"])
        if key in self.seen_seeds:
            self.progress["replays"] += 1
            return "rejeu"
        if hdr["flags"] & FLAG_ENCRYPTED:
            if not self.data_key:
                self.errors.append("appairage-requis")
                return "invalide"
            nonce = frame_nonce(self.nonce_key, hdr["block"], hdr["seed"])
            plaintext = aead_decrypt(self.data_key, nonce, payload, tag, hdr["meta"] + hdr["headerBytes"])
            if plaintext is None:
                self.progress["forged"] += 1
                return "falsifiee"
            payload = plaintext
        k = hdr["k"]
        dec = self.decoders.setdefault(hdr["block"], Decoder(k))
        new_seeds = [(hdr["seed"] + i) & 0xFFFFFFFF for i in range(hdr["symbolCount"])
                     if (hdr["seed"] + i) & 0xFFFFFFFF not in dec.seen_seeds]
        for i in range(hdr["symbolCount"]):
            g = (hdr["seed"] + i) & 0xFFFFFFFF
            dec.receive(g, payload[i * 96:(i + 1) * 96])
        self.progress["receivedSymbols"] += len(new_seeds)
        self.seen_seeds.add(key)
        self.progress["receivedFrames"] += 1
        if len(self.decoders) == self.block_count and all(d.complete for d in self.decoders.values()):
            self.progress["completedBlocks"] = self.block_count
            if self.result is None:
                self._rebuild()
        return "accepted"

    def _rebuild(self) -> None:
        stream = b"".join(sym for b in range(self.block_count) for sym in self.decoders[b].symbols())
        stream = stream[:self.stream_size]
        if sha256(stream) != self.digest:
            self.errors.append("integrite")
            return
        if self.compressed:
            stream = decompress(stream)
        self.result = stream
