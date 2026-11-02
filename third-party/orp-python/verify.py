#!/usr/bin/env python3
"""Replays the ORP v0.1 interoperability vectors — checklist §10.4 of the guide, items 1 to 9.

Usage: python3 -I verify.py <vector directory, e.g. ../../native/vectors/core>
One item = one domain; a failure prints the first diverging cases and the total.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from orp import OrpError
from orp.blocks import plan
from orp.compression import compress, decompress
from orp.encryption import (aead_decrypt, aead_encrypt, frame_nonce, hkdf, hmac_sha256,
                            key_pair_from_scalar, sha256, shared_secret)
from orp.fountain import Decoder, neighbors, symbol
from orp.frames import build, read
from orp.pairing import init_code, keys, passphrase_path, read_init_code, response_code, token
from orp.primitives import crc32, mulberry32, prng_bytes
from orp.rs import correct, parity
from orp.session import Receiver, Sender


class Report:
    def __init__(self):
        self.results = []

    def item(self, number: int, name: str, total: int, failures: list[str]):
        status = "GREEN" if not failures else "RED"
        self.results.append((number, name, total, len(failures), status))
        for e in failures[:3]:
            print(f"      failure: {e}")
        if len(failures) > 3:
            print(f"      … and {len(failures) - 3} more")


def hx(s: str) -> bytes:
    return bytes.fromhex(s)


def verify_crc32(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v):
        if crc32(hx(case["data"])) != case["crc"]:
            failures.append(f"case {i}")
    return failures


def verify_mulberry32(v: dict) -> list[str]:
    failures = []
    for case in v:
        g = mulberry32(case["seed"])
        for i, expected in enumerate(case["integers"]):
            if next(g) != expected:
                failures.append(f"seed {case['seed']} draw {i}")
                break
    return failures


def verify_rs(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["parities"]):
        if parity(hx(case["message"])) != hx(case["parity"]):
            failures.append(f"parity {i} ({len(case['message'])} B)")
    for i, case in enumerate(v["corrections"]):
        obtained = correct(hx(case["damaged"]))
        expected = None if case["result"] is None else hx(case["result"])
        if obtained != expected:
            failures.append(f"correction {i}: obtained {'None' if obtained is None else obtained.hex()[:20]}")
    return failures


def _expected_header(e: dict) -> dict:
    return {k: e[k] for k in ("version", "codec", "flags", "token", "block", "k", "symbolCount", "seed")}


def verify_frames(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["built"]):
        try:
            frame = build(case["header"], hx(case["payload"]), None if case["tag"] is None else hx(case["tag"]))
            if frame != hx(case["frame"]):
                failures.append(f"built {i}: {len(frame)} B vs expected {len(hx(case['frame']))} B")
        except OrpError as e:
            failures.append(f"built {i}: raised {e.code}")
    for i, case in enumerate(v["refusals"]):
        try:
            build(case["header"], hx(case["payload"]), None if case["tag"] is None else hx(case["tag"]))
            failures.append(f"refusals {i}: no error raised")
        except OrpError as e:
            if e.code != case["error"]:
                failures.append(f"refusals {i}: {e.code} vs expected {case['error']}")
    for i, case in enumerate(v["reads"]):
        try:
            hdr, payload, tag = read(hx(case["raw"]))
            if "error" in case and case["error"]:
                failures.append(f"reads {i}: read without error, expected {case['error']}")
                continue
            if _expected_header(hdr) != case["header"]:
                failures.append(f"reads {i}: header diverges")
            if payload != hx(case["payload"]):
                failures.append(f"reads {i}: payload diverges")
            expected_tag = None if case.get("tag") is None else hx(case["tag"])
            if tag != expected_tag:
                failures.append(f"reads {i}: tag diverges")
        except OrpError as e:
            if not case.get("error"):
                failures.append(f"reads {i}: raised {e.code}, expected success")
            elif e.code != case["error"]:
                failures.append(f"reads {i}: {e.code} vs expected {case['error']}")
    return failures


def verify_blocks(v: dict) -> list[str]:
    failures = []
    for i, p in enumerate(v["plans"]):
        k_obtained, blocks = plan(hx(p["stream"]), p["symbolSize"], p["kMax"])
        if k_obtained != p["kPerBlock"]:
            failures.append(f"plan {i}: kPerBlock {k_obtained} vs {p['kPerBlock']}")
            continue
        flat = [s.hex() for block in blocks for s in block]
        if flat != list(p["symbols"]):
            failures.append(f"plan {i}: symbols diverge")
    return failures


def verify_fountain(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["neighbors"]):
        if neighbors(case["k"], case["seed"]) != case["neighbors"]:
            failures.append(f"neighbors {i} (k={case['k']}, seed={case['seed']})")
            if len(failures) > 2:
                break
    for i, case in enumerate(v["symbols"]):
        sources = [hx(s) for s in case["sources"]]
        for f in case["fountain"]:
            obtained = symbol(sources, neighbors(case["k"], f["seed"]))
            if obtained != hx(f["symbol"]):
                failures.append(f"symbols {i} seed {f['seed']}")
    for i, case in enumerate(v["decodings"]):
        sources = [hx(s) for s in case["sources"]]
        dec = Decoder(case["k"])
        for j, step in enumerate(case["steps"]):
            progress, complete, received = dec.receive(step["seed"],
                                                       symbol(sources, neighbors(case["k"], step["seed"])))
            if progress != step["progress"] or complete != step["complete"] or received != step["receivedSymbols"]:
                failures.append(f"decodings {i} step {j}: ({progress},{complete},{received}) "
                                f"vs ({step['progress']},{step['complete']},{step['receivedSymbols']})")
                break
        if bool(dec.complete) != case["complete"]:
            failures.append(f"decodings {i}: final complete {dec.complete}")
    return failures


def verify_encryption(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["ecdh"]):
        key_a, pub_a = key_pair_from_scalar(hx(case["privateA"]))
        key_b, pub_b = key_pair_from_scalar(hx(case["privateB"]))
        if pub_a != hx(case["publicA"]):
            failures.append(f"ecdh {i}: publicA diverges")
        if pub_b != hx(case["publicB"]):
            failures.append(f"ecdh {i}: publicB diverges")
        if shared_secret(key_a, pub_b) != hx(case["secret"]) or shared_secret(key_b, pub_a) != hx(case["secret"]):
            failures.append(f"ecdh {i}: secret diverges")
    for i, case in enumerate(v["hkdf"]):
        if hkdf(hx(case["secret"]), hx(case["salt"]), case["info"].encode(), case["length"]) != hx(case["output"]):
            failures.append(f"hkdf {i}")
    for i, case in enumerate(v["aead"]):
        ciphertext, tag = aead_encrypt(hx(case["key"]), hx(case["nonce"]), hx(case["plaintext"]), hx(case["aad"]))
        if ciphertext != hx(case["ciphertext"]) or tag != hx(case["tag"]):
            failures.append(f"aead {i}: encryption diverges")
        if aead_decrypt(hx(case["key"]), hx(case["nonce"]), hx(case["ciphertext"]), hx(case["tag"]),
                        hx(case["aad"])) != hx(case["plaintext"]):
            failures.append(f"aead {i}: decryption diverges")
    for i, case in enumerate(v["hmac"]):
        if hmac_sha256(hx(case["key"]), hx(case["data"])) != hx(case["mac"]):
            failures.append(f"hmac {i}")
    for i, case in enumerate(v["sha256"]):
        if sha256(hx(case["data"])) != hx(case["digest"]):
            failures.append(f"sha256 {i}")
    for i, case in enumerate(v["prng"]):
        if prng_bytes(case["seed"], 64) != hx(case["bytes"]):
            failures.append(f"prng {i}")
    return failures


def verify_pairing(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["initCodes"]):
        code = init_code(hx(case["sessionId"]), hx(case["senderPublicKey"]), case["streamSize"],
                         hx(case["streamDigest"]), case["blockCount"], case["kTotal"],
                         case["compressed"], case["byPassphrase"])
        if code != hx(case["code"]):
            failures.append(f"initCodes {i}: code diverges")
        decoded = read_init_code(code)
        read_back = {"blockCount": decoded["block_count"], "kTotal": decoded["k_total"],
                     "streamSize": decoded["stream_size"]}
        if read_back != case["readBack"]:
            failures.append(f"initCodes {i}: re-read diverges")
    for i, case in enumerate(v["responseCodes"]):
        code = response_code(hx(case["sessionId"]), hx(case["receiverPublicKey"]), case["sasSeed"])
        if code != hx(case["code"]):
            failures.append(f"responseCodes {i}: code diverges")
    for i, case in enumerate(v["keys"]):
        d, n, sas = keys(hx(case["secret"]), hx(case["sessionId"]), case["sasSeed"])
        if d != hx(case["dataKey"]) or n != hx(case["nonceKey"]) or sas != int(case["sas"]):
            failures.append(f"keys {i}: SAS obtained {sas} vs {case['sas']}")
    for i, case in enumerate(v["passphrases"]):
        if case.get("error"):
            try:
                passphrase_path(case["passphrase"], hx(case["sessionId"]))
                failures.append(f"passphrases {i}: accepted although {case['error']} expected")
            except OrpError as e:
                if e.code != case["error"]:
                    failures.append(f"passphrases {i}: {e.code} vs {case['error']}")
            continue
        secret, ss = passphrase_path(case["passphrase"], hx(case["sessionId"]))
        d, n, sas = keys(secret, hx(case["sessionId"]), ss)
        if secret != hx(case["secret"]) or ss != case["sasSeed"] or d != hx(case["dataKey"]) or sas != int(case["sas"]):
            failures.append(f"passphrases {i}: derivation diverges")
    for i, case in enumerate(v["nonces"]):
        if frame_nonce(hx(case["key"]), case["block"], case["seed"]) != hx(case["nonce"]):
            failures.append(f"nonces {i}")
    for i, case in enumerate(v["tokens"]):
        if token(hx(case["sessionId"])) != case["token"]:
            failures.append(f"tokens {i}")
    return failures


def verify_compression(v: dict) -> list[str]:
    failures = []
    for i, case in enumerate(v["cases"]):
        data = hx(case["input"])
        if case["compressed"] is not None:
            if decompress(hx(case["compressed"])) != data:
                failures.append(f"case {i}: decompression diverges")
        output = compress(data)
        if case["compressed"] is None:
            if output is not None:
                failures.append(f"case {i}: null expected (no gain)")
        else:
            if output is not None and decompress(output) != data:
                failures.append(f"case {i}: round trip diverges")
    return failures


def verify_sessions(v: dict) -> list[str]:
    failures = []
    for i, sc in enumerate(v["sessions"]):
        label = f"session {i} ({sc['name']})"
        sender = Sender(sc["senderSeed"], sc.get("codecs", [3]), sc.get("fallback"),
                        encrypt=sc["encryption"] == "required")
        receiver = Receiver(sc["receiverSeed"] if sc["pairing"] == "codes" else None)
        file = hx(sc["file"])
        stream = file
        is_compressed = bool(sc["compression"])
        if is_compressed:
            stream = compress(file)
            if stream is None:
                stream = file
                is_compressed = False
        sender.prepare(stream, is_compressed, sc["pairing"] == "passphrase")
        if sender.code != hx(sc["initCode"]):
            failures.append(f"{label}: init code diverges")
            continue
        if sc["pairing"] == "passphrase":
            if sender.accept_passphrase(sc["passphrase"]) != int(sc["sas"]):
                failures.append(f"{label}: sender SAS {sender.sas} vs {sc['sas']}")
                continue
            receiver.accept_init(sender.code)
            if receiver.pair_passphrase(sc["passphrase"]) != int(sc["sas"]):
                failures.append(f"{label}: receiver SAS diverges")
                continue
        else:
            receiver.accept_init(sender.code)
            if receiver.pair_strong() != int(sc["sas"]):
                failures.append(f"{label}: receiver SAS diverges")
                continue
            response = receiver.produce_response()
            if response != hx(sc["responseCode"]):
                failures.append(f"{label}: response code diverges")
                continue
            if sender.accept_response(response) != int(sc["sas"]):
                failures.append(f"{label}: sender SAS diverges")
                continue
        sent = sender.send(sc["passes"])
        expected = [hx(t) for t in sc["frames"]]
        divergences = [j for j, (a, e) in enumerate(zip(sent, expected)) if a != e]
        if len(sent) != len(expected) or divergences:
            first = divergences[0] if divergences else min(len(sent), len(expected))
            failures.append(f"{label}: frames diverge — {len(sent)} sent vs {len(expected)} expected, "
                            f"first divergence at index {first}")
            continue
        statuses = []
        for r in sc["received"]:
            if "frame" in r:
                statuses.append(receiver.receive(expected[r["frame"]]))
            else:
                statuses.append(receiver.receive(hx(r["raw"])))
        if statuses != sc["statuses"]:
            first = next(j for j, (a, e) in enumerate(zip(statuses, sc["statuses"])) if a != e)
            failures.append(f"{label}: statuses diverge at rank {first} "
                            f"({statuses[first]} vs {sc['statuses'][first]})")
            continue
        if receiver.progress != sc["progress"]:
            failures.append(f"{label}: progress {receiver.progress} vs {sc['progress']}")
            continue
        if receiver.result != file:
            failures.append(f"{label}: result diverges from the file")
    return failures


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "native/vectors/core")
    load = lambda name: json.loads((directory / f"{name}.json").read_text())
    report = Report()
    report.item(1, "CRC-32", 10, verify_crc32(load("crc32")))
    report.item(2, "PRNG mulberry32", 9 * 64, verify_mulberry32(load("mulberry32")))
    report.item(3, "Frame (meta, body, segments)", 165, verify_frames(load("frames")))
    report.item(4, "Reed-Solomon", 103, verify_rs(load("rs")))
    report.item(5, "Splitting into blocks", 7, verify_blocks(load("blocks")))
    report.item(6, "Fountain", 1395, verify_fountain(load("fountain")))
    report.item(7, "Cryptographic primitives", 25, verify_encryption(load("encryption")))
    report.item(8, "Pairing", 25, verify_pairing(load("pairing")))
    report.item(8, "deflate-raw compression", 5, verify_compression(load("compression")))
    report.item(9, "Complete sessions", 5, verify_sessions(load("sessions")))
    print()
    green = True
    for number, name, total, fail_count, status in report.results:
        print(f"  item {number} — {name}: {total - fail_count}/{total} — {status}")
        green = green and not fail_count
    print()
    print("CHECKLIST §10.4 (items 1–9):", "GREEN" if green else "FAILING")
    sys.exit(0 if green else 1)


if __name__ == "__main__":
    main()
