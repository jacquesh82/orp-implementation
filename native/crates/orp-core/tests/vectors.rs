//! Reference vectors produced by `packages/core` (TypeScript) —
//! native/vectors/generate-core.ts. A single diverging byte is a failure.

use std::sync::{Arc, Mutex};

use orp_core::pairing::*;
use orp_core::blocks::{plan_with, BlockPlan};
use orp_core::encryption::{CryptoRust, CryptoProvider, EcdhPair};
use orp_core::compression::{compress, decompress};
use orp_core::fountain::{fountain_symbol, lt_neighbors, FountainDecoder};
use orp_core::session::*;
use orp_core::frames::*;
use orp_core::{correct_rs, rs_parity, MulberryRandom, Mulberry32, RandomSource};
use serde_json::Value;

fn load(name: &str) -> Value {
    let path = format!("{}/../../vectors/core/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap()
}

fn hex(v: &Value) -> Vec<u8> {
    let s = v.as_str().expect("hex string expected");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn hex_opt(v: &Value) -> Option<Vec<u8>> {
    (!v.is_null()).then(|| hex(v))
}

fn count(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("integer expected: {v}"))
}

fn crypto(seed: u64) -> Box<CryptoRust> {
    Box::new(CryptoRust::with_random(Box::new(MulberryRandom::new(seed as u32))))
}

#[test]
fn crc32_matches_ts() {
    for c in load("crc32.json").as_array().unwrap() {
        assert_eq!(crc32(&hex(&c["data"])) as u64, count(&c["crc"]));
    }
}

#[test]
fn mulberry32_matches_ts() {
    for c in load("mulberry32.json").as_array().unwrap() {
        let mut rng = Mulberry32::new(count(&c["seed"]) as u32);
        for e in c["integers"].as_array().unwrap() {
            assert_eq!(rng.next_f64() * 4_294_967_296.0, e.as_f64().unwrap());
        }
    }
}

#[test]
fn reed_solomon_matches_ts() {
    let v = load("rs.json");
    for c in v["parities"].as_array().unwrap() {
        assert_eq!(rs_parity(&hex(&c["message"])).to_vec(), hex(&c["parity"]));
    }
    let mut failures = 0;
    for c in v["corrections"].as_array().unwrap() {
        let mut t = hex(&c["damaged"]);
        match (correct_rs(&mut t), hex_opt(&c["result"])) {
            (Ok(()), Some(expected)) => assert_eq!(t, expected),
            (Err(_), None) => failures += 1,
            (r, a) => panic!("RS divergence: rust {r:?}, ts {:?}", a.is_some()),
        }
    }
    assert!(failures > 0, "the vectors must cover correction failures");
}

fn header_of(v: &Value) -> FrameHeader {
    FrameHeader {
        version: Version {
            major: count(&v["version"]["major"]) as u8,
            minor: count(&v["version"]["minor"]) as u8,
        },
        codec: Codec::from_u8(count(&v["codec"]) as u8).unwrap(),
        flags: count(&v["flags"]) as u8,
        token: count(&v["token"]) as u32,
        block: count(&v["block"]) as u32,
        k: count(&v["k"]) as u16,
        symbol_count: count(&v["symbolCount"]) as u8,
        seed: count(&v["seed"]) as u32,
    }
}

#[test]
fn frames_match_ts() {
    let v = load("frames.json");
    for c in v["built"].as_array().unwrap() {
        let e = header_of(&c["header"]);
        let tag = hex_opt(&c["tag"]);
        let frame = build_frame(&e, &hex(&c["payload"]), tag.as_deref()).unwrap();
        assert_eq!(frame, hex(&c["frame"]));
        assert_eq!(frame.len(), frame_size(e.symbol_count as usize, tag.is_some()));
        let parsed = read_frame(&frame).unwrap();
        assert_eq!(parsed.header, e);
        assert_eq!(parsed.tag, tag);
    }
    for c in v["refusals"].as_array().unwrap() {
        let e = header_of(&c["header"]);
        let r = build_frame(&e, &hex(&c["payload"]), hex_opt(&c["tag"]).as_deref());
        assert_eq!(r.unwrap_err().code(), c["error"].as_str().unwrap());
    }
    for c in v["reads"].as_array().unwrap() {
        let r = read_frame(&hex(&c["raw"]));
        match (&r, c["error"].as_str()) {
            (Ok(l), None) => {
                assert_eq!(l.header, header_of(&c["header"]));
                assert_eq!(l.payload, hex(&c["payload"]));
                assert_eq!(l.tag, hex_opt(&c["tag"]));
            }
            (Err(e), Some(code)) => assert_eq!(e.code(), code),
            _ => panic!("reading divergence: rust {r:?}, ts {}", c["error"]),
        }
    }
}

#[test]
fn fountain_matches_ts() {
    let v = load("fountain.json");
    for c in v["neighbors"].as_array().unwrap() {
        let k = count(&c["k"]) as usize;
        let expected_list: Vec<u32> = c["neighbors"].as_array().unwrap().iter().map(|x| count(x) as u32).collect();
        assert_eq!(lt_neighbors(k, count(&c["seed"]) as u32), expected_list, "k = {k}, seed = {}", c["seed"]);
    }
    for c in v["symbols"].as_array().unwrap() {
        let k = count(&c["k"]) as usize;
        let sources: Vec<Vec<u8>> = c["sources"].as_array().unwrap().iter().map(hex).collect();
        for f in c["fountain"].as_array().unwrap() {
            assert_eq!(fountain_symbol(&sources, k, count(&f["seed"]) as u32).unwrap(), hex(&f["symbol"]));
        }
    }
    for c in v["decodings"].as_array().unwrap() {
        let k = count(&c["k"]) as usize;
        let sources: Vec<Vec<u8>> = c["sources"].as_array().unwrap().iter().map(hex).collect();
        let mut d = FountainDecoder::new(k).unwrap();
        for p in c["steps"].as_array().unwrap() {
            let g = count(&p["seed"]) as u32;
            let progress = d.receive(g, &fountain_symbol(&sources, k, g).unwrap()).unwrap();
            assert_eq!(progress, p["progress"].as_bool().unwrap(), "k = {k}, seed {g}");
            assert_eq!(d.is_complete(), p["complete"].as_bool().unwrap());
            assert_eq!(d.received_symbols() as u64, count(&p["receivedSymbols"]));
        }
        assert_eq!(d.is_complete(), c["complete"].as_bool().unwrap());
        if d.is_complete() {
            assert_eq!(d.rebuild().unwrap(), sources);
        }
    }
}

#[test]
fn blocks_match_ts() {
    for c in load("blocks.json")["plans"].as_array().unwrap() {
        let stream = hex(&c["stream"]);
        let plan: BlockPlan =
            plan_with(&stream, count(&c["symbolSize"]) as usize, count(&c["kMax"]) as usize).unwrap();
        let k: Vec<usize> = c["kPerBlock"].as_array().unwrap().iter().map(|x| count(x) as usize).collect();
        assert_eq!(plan.k_per_block, k);
        let symbols: Vec<Vec<u8>> = c["symbols"].as_array().unwrap().iter().map(hex).collect();
        assert_eq!(plan.symbols, symbols);
        assert_eq!(plan.stream_size, stream.len());
    }
}

#[test]
fn compression_compatible() {
    let (mut identical, mut total) = (0, 0);
    for c in load("compression.json")["cases"].as_array().unwrap() {
        let input = hex(&c["input"]);
        // The browser's stream decompresses identically.
        if let Some(ts) = hex_opt(&c["compressed"]) {
            assert_eq!(decompress(&ts).unwrap(), input);
        }
        // Ours round-trips, and agrees on what is incompressible.
        match compress(&input) {
            Some(r) => {
                assert_eq!(decompress(&r).unwrap(), input);
                total += 1;
                identical += usize::from(hex_opt(&c["compressed"]).as_ref() == Some(&r));
            }
            None => assert!(c["compressed"].is_null(), "miniz does not compress what zlib compresses"),
        }
    }
    // Same zlib, same parameters: the stream must be the browser's.
    assert_eq!(identical, total, "deflate-raw differs from the browser");
}

#[test]
fn encryption_matches_ts() {
    let v = load("encryption.json");
    let c = CryptoRust::new();
    for e in v["ecdh"].as_array().unwrap() {
        let a = EcdhPair::from_scalar(&hex(&e["privateA"])).unwrap();
        let b = EcdhPair::from_scalar(&hex(&e["privateB"])).unwrap();
        assert_eq!(a.public_key.to_vec(), hex(&e["publicA"]));
        assert_eq!(b.public_key.to_vec(), hex(&e["publicB"]));
        assert_eq!(c.ecdh_agree(&a.private_key, &b.public_key).unwrap().to_vec(), hex(&e["secret"]));
        assert_eq!(c.ecdh_agree(&b.private_key, &a.public_key).unwrap().to_vec(), hex(&e["secret"]));
    }
    for h in v["hkdf"].as_array().unwrap() {
        let o = c
            .derive_hkdf(&hex(&h["secret"]), &hex(&h["salt"]), h["info"].as_str().unwrap(), count(&h["length"]) as usize)
            .unwrap();
        assert_eq!(o, hex(&h["output"]));
    }
    for a in v["aead"].as_array().unwrap() {
        let (key, nonce, aad) = (hex(&a["key"]), hex(&a["nonce"]), hex(&a["aad"]));
        let (encrypted, tag) = c.encrypt_aead(&key, &nonce, &hex(&a["plaintext"]), &aad).unwrap();
        assert_eq!(encrypted, hex(&a["ciphertext"]));
        assert_eq!(tag.to_vec(), hex(&a["tag"]));
        assert_eq!(c.decrypt_aead(&key, &nonce, &encrypted, &tag, &aad).unwrap(), hex(&a["plaintext"]));
        let mut tampered = tag;
        tampered[0] ^= 1;
        assert!(c.decrypt_aead(&key, &nonce, &encrypted, &tampered, &aad).is_err());
        assert!(c.decrypt_aead(&key, &nonce, &encrypted, &tag, &[9, 9, 9]).is_err());
    }
    for h in v["hmac"].as_array().unwrap() {
        assert_eq!(c.hmac_sha256(&hex(&h["key"]), &hex(&h["data"])).to_vec(), hex(&h["mac"]));
    }
    for s in v["sha256"].as_array().unwrap() {
        assert_eq!(c.sha256(&hex(&s["data"])).to_vec(), hex(&s["digest"]));
    }
    for a in v["prng"].as_array().unwrap() {
        let mut o = vec![0u8; 64];
        MulberryRandom::new(count(&a["seed"]) as u32).fill(&mut o);
        assert_eq!(o, hex(&a["bytes"]));
    }
}

#[test]
fn pairing_matches_ts() {
    let v = load("pairing.json");
    let c = CryptoRust::new();
    for i in v["initCodes"].as_array().unwrap() {
        let commitment = commitment_of(&c, &hex(&i["sessionId"]), &hex(&i["senderPublicKey"]));
        assert_eq!(commitment.to_vec(), hex(&i["commitment"]));
        let info = InitCodeInfo {
            session_id: hex(&i["sessionId"]),
            commitment: commitment.to_vec(),
            stream_size: count(&i["streamSize"]),
            stream_digest: hex(&i["streamDigest"]),
            block_count: count(&i["blockCount"]) as u32,
            k_total: count(&i["kTotal"]) as u32,
            compressed: i["compressed"].as_bool().unwrap(),
            by_passphrase: i["byPassphrase"].as_bool().unwrap(),
            encrypted: i["encrypted"].as_bool().unwrap(),
        };
        assert_eq!(expected_layout(info.stream_size), (info.block_count as u64, info.k_total as u64));
        let code = write_init_code(&info).unwrap();
        assert_eq!(code, hex(&i["code"]));
        assert_eq!(pairing_code_kind(&code), Some(PairingCodeKind::Init));
        let decoded = read_init_code(&code).unwrap();
        assert_eq!(decoded.block_count as u64, count(&i["readBack"]["blockCount"]));
        assert_eq!(decoded.k_total as u64, count(&i["readBack"]["kTotal"]));
        assert_eq!(decoded.stream_size, count(&i["readBack"]["streamSize"]));
        assert_eq!(decoded, info);
    }
    for i in v["invalidCodes"].as_array().unwrap() {
        let code = hex(&i["code"]);
        let error = match i["kind"].as_str().unwrap() {
            "init" => read_init_code(&code).unwrap_err(),
            "response" => read_response_code(&code).unwrap_err(),
            _ => read_reveal_code(&code).unwrap_err(),
        };
        assert_eq!(error.code(), i["error"].as_str().unwrap(), "{}", i["code"]);
    }
    for r in v["responseCodes"].as_array().unwrap() {
        let code = write_response_code(&hex(&r["sessionId"]), &hex(&r["receiverPublicKey"])).unwrap();
        assert_eq!(code, hex(&r["code"]));
        assert_eq!(pairing_code_kind(&code), Some(PairingCodeKind::Response));
        let decoded = read_response_code(&code).unwrap();
        assert_eq!(decoded.session_id, hex(&r["sessionId"]));
        assert_eq!(decoded.receiver_pub, hex(&r["receiverPublicKey"]));
    }
    for r in v["revealCodes"].as_array().unwrap() {
        let code = write_reveal_code(&hex(&r["sessionId"]), &hex(&r["senderPublicKey"])).unwrap();
        assert_eq!(code, hex(&r["code"]));
        assert_eq!(pairing_code_kind(&code), Some(PairingCodeKind::Reveal));
        let decoded = read_reveal_code(&code).unwrap();
        assert_eq!(decoded.session_id, hex(&r["sessionId"]));
        assert_eq!(decoded.sender_pub, hex(&r["senderPublicKey"]));
    }
    for t in v["transcripts"].as_array().unwrap() {
        let (response, reveal) = (hex_opt(&t["response"]), hex_opt(&t["reveal"]));
        let hash = transcript_hash(&c, &hex(&t["init"]), response.as_deref(), reveal.as_deref());
        assert_eq!(hash.to_vec(), hex(&t["hash"]));
    }
    for k in v["keys"].as_array().unwrap() {
        let keys = derive_keys(&c, &hex(&k["secret"]), &hex(&k["transcript"])).unwrap();
        assert_eq!(keys.data_key, hex(&k["dataKey"]));
        assert_eq!(keys.nonce_key, hex(&k["nonceKey"]));
        assert_eq!(keys.sas, k["sas"].as_str().unwrap());
    }
    for p in v["passphrases"].as_array().unwrap() {
        let passphrase = p["passphrase"].as_str().unwrap();
        let sid = hex(&p["sessionId"]);
        let init = hex(&p["initCode"]);
        assert_eq!(read_init_code(&init).unwrap().session_id, sid);
        match p["error"].as_str() {
            Some(code) => {
                assert_eq!(derive_secret_from_passphrase(&c, passphrase, &sid).unwrap_err().code(), code);
                assert_eq!(derive_keys_from_passphrase(&c, passphrase, &init).unwrap_err().code(), code);
            }
            None => {
                assert_eq!(derive_secret_from_passphrase(&c, passphrase, &sid).unwrap(), hex(&p["secret"]));
                let keys = derive_keys_from_passphrase(&c, passphrase, &init).unwrap();
                assert_eq!(keys.data_key, hex(&p["dataKey"]));
                assert_eq!(keys.nonce_key, hex(&p["nonceKey"]));
                assert_eq!(keys.sas, p["sas"].as_str().unwrap());
            }
        }
    }
    for n in v["nonces"].as_array().unwrap() {
        let nonce = frame_nonce(&c, &hex(&n["key"]), count(&n["block"]) as u32, count(&n["seed"]) as u32);
        assert_eq!(nonce.to_vec(), hex(&n["nonce"]));
    }
    for j in v["tokens"].as_array().unwrap() {
        assert_eq!(token_of(&hex(&j["sessionId"])) as u64, count(&j["token"]));
    }
}

fn codec_of(v: &Value) -> Codec {
    Codec::from_u8(count(v) as u8).unwrap()
}

fn status_name(s: FrameStatus) -> &'static str {
    match s {
        FrameStatus::Accepted => "accepted",
        FrameStatus::Rejected(r) => r.name(),
    }
}

/// Full session: the Rust sender, fed the same randomness as the TS, must
/// produce the same codes and the same frames; the Rust receiver, fed the TS
/// frames (losses, duplicate, forgery…), the same statuses and the same
/// file.
#[test]
fn sessions_match_ts() {
    let sessions = load("sessions.json");
    let sessions = sessions["sessions"].as_array().unwrap();
    for s in sessions {
        let name = s["name"].as_str().unwrap();
        let file = hex(&s["file"]);
        let ts_frames: Vec<Vec<u8>> = s["frames"].as_array().unwrap().iter().map(hex).collect();
        let options = TransmissionOptions {
            encryption: match s["encryption"].as_str().unwrap() {
                "required" => Encryption::Required,
                "optional" => Encryption::Optional,
                _ => Encryption::Disabled,
            },
            compression: s["compression"].as_bool().unwrap(),
            pairing: if s["pairing"] == "passphrase" { PairingMode::Passphrase } else { PairingMode::Codes },
            codecs: match s["codecs"].as_array() {
                Some(l) => l.iter().map(codec_of).collect(),
                None => TransmissionOptions::default().codecs,
            },
            ..TransmissionOptions::default()
        };
        let mut sender = SenderSession::new(crypto(count(&s["senderSeed"])), options).unwrap();
        // A sender in encryption "none" must be accepted explicitly (v0.2).
        let reception = ReceptionOptions {
            encryption: if s["encryption"] == "none" { Encryption::Optional } else { Encryption::Required },
            ..ReceptionOptions::default()
        };
        let mut receiver = ReceiverSession::with_options(crypto(count(&s["receiverSeed"])), reception);
        sender.prepare(&file).unwrap();
        let init_code = sender.init_code().unwrap();
        // With compression, identity depends on zlib (see compression.rs): it
        // is required here, the test platform having the reference zlib.
        assert_eq!(init_code, hex(&s["initCode"]), "{name}: diverging init code");

        // The receiver works on the TS code and frames.
        receiver.show_init_code(&hex(&s["initCode"])).unwrap();
        if s["pairing"] == "codes" {
            let response = receiver.response_code().unwrap();
            assert_eq!(response, hex(&s["responseCode"]), "{name}: diverging response code");
            sender.receive_response_code(&response).unwrap();
            let reveal = sender.reveal_code().unwrap();
            assert_eq!(reveal, hex(&s["revealCode"]), "{name}: diverging reveal code");
            receiver.receive_reveal_code(&reveal).unwrap();
        } else {
            let passphrase = s["passphrase"].as_str().unwrap();
            receiver.pair_by_passphrase(passphrase).unwrap();
            sender.receive_passphrase(passphrase).unwrap();
        }
        assert_eq!(receiver.sas().unwrap(), s["sas"].as_str().unwrap(), "{name}: diverging SAS");
        receiver.confirm_sas().unwrap();

        assert_eq!(sender.sas().unwrap(), s["sas"].as_str().unwrap());
        sender.confirm_sas().unwrap();
        let fallback = s.get("fallback").filter(|r| !r.is_null()).map(|r| (count(&r["after"]), codec_of(&r["codec"])));
        let end_reasons = Arc::new(Mutex::new(Vec::new()));
        let f = end_reasons.clone();
        sender.on_event(move |e| {
            if let SenderEvent::End { reason } = e {
                f.lock().unwrap().push(*reason);
            }
        });
        let mut frames = Vec::new();
        sender
            .send_all(count(&s["passes"]) as u32, |em, t| {
                frames.push(t);
                if let Some((after, codec)) = fallback {
                    if frames.len() as u64 == after {
                        em.change_codec(codec)?;
                    }
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(frames.len(), ts_frames.len(), "{name}: frame count");
        for (i, (a, b)) in frames.iter().zip(&ts_frames).enumerate() {
            assert_eq!(a, b, "{name}: frame {i} diverges");
        }
        assert_eq!(*end_reasons.lock().unwrap(), vec![EndReason::Passes]);
        assert_eq!(sender.state(), SessionState::Finished);

        let mut statuses = Vec::new();
        for r in s["received"].as_array().unwrap() {
            let raw = match r.get("frame") {
                Some(i) => ts_frames[count(i) as usize].clone(),
                None => hex(&r["raw"]),
            };
            statuses.push(status_name(receiver.receive_frame(&raw).unwrap()));
        }
        let expected_list: Vec<&str> = s["statuses"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert_eq!(statuses, expected_list, "{name}: receive statuses");
        let p = receiver.progress();
        let q = &s["progress"];
        assert_eq!(
            (p.completed_blocks, p.block_count, p.received_symbols),
            (count(&q["completedBlocks"]) as usize, count(&q["blockCount"]) as usize, count(&q["receivedSymbols"]) as usize),
            "{name}: progress"
        );
        assert_eq!(
            (p.received_frames, p.replays, p.forged, p.corrupted),
            (count(&q["receivedFrames"]), count(&q["replays"]), count(&q["forged"]), count(&q["corrupted"])),
            "{name}: counters"
        );
        match hex_opt(&s["result"]) {
            Some(expected) => assert_eq!(receiver.result().unwrap().data, expected),
            None => assert!(!receiver.finished()),
        }
    }
}
