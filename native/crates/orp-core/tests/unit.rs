//! Port of the unit tests in packages/core/test/*.spec.ts (system randomness,
//! like the TS on WebCrypto; the TS "random" draws are seeded here).

use std::sync::{Arc, Mutex};

use orp_core::pairing::*;
use orp_core::blocks::{assemble, plan_blocks};
use orp_core::encryption::{CryptoRust, CryptoProvider};
use orp_core::fountain::{fountain_symbol, lt_neighbors, FountainDecoder};
use orp_core::session::*;
use orp_core::frames::*;
use orp_core::{correct_rs, rs_parity, OrpError, Mulberry32};

fn random(rng: &mut Mulberry32, n: usize) -> Vec<u8> {
    (0..n).map(|_| (rng.next_f64() * 256.0) as u8).collect()
}

fn header(symbol_count: u8, flags: u8) -> FrameHeader {
    FrameHeader {
        version: FRAME_VERSION,
        codec: Codec::Color4,
        flags,
        token: 0x1234_5678,
        block: 3,
        k: 100,
        symbol_count,
        seed: 42,
    }
}

// ── frames.spec.ts ────────────────────────────────────────────────────────

#[test]
fn crc32_ieee_vector() {
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
}

#[test]
fn frame_round_trip_with_and_without_encryption() {
    for encrypted in [false, true] {
        let payload: Vec<u8> = (0..2 * SYMBOL_SIZE).map(|i| (i * 7) as u8).collect();
        let tag = encrypted.then(|| vec![0xaa; 16]);
        let raw =
            build_frame(&header(2, if encrypted { FLAG_ENCRYPTED } else { 0 }), &payload, tag.as_deref()).unwrap();
        assert_eq!(raw.len(), frame_size(2, encrypted));
        let parsed = read_frame(&raw).unwrap();
        assert_eq!((parsed.header.token, parsed.header.block, parsed.header.k, parsed.header.seed), (0x1234_5678, 3, 100, 42));
        assert_eq!(parsed.payload, payload);
        assert_eq!(parsed.tag, tag);
    }
}

#[test]
fn frame_tolerates_grid_padding() {
    let mut raw = build_frame(&header(1, 0), &[0; SYMBOL_SIZE], None).unwrap();
    raw.extend_from_slice(&[0; 20]);
    assert_eq!(read_frame(&raw).unwrap().header.token, 0x1234_5678);
}

#[test]
fn meta_majority_vote() {
    let raw = build_frame(&header(1, 0), &[0; SYMBOL_SIZE], None).unwrap();
    for copy in 0..3 {
        let mut damaged = raw.clone();
        damaged[copy * 8 + 1] = 0xff;
        assert_eq!(read_frame(&damaged).unwrap().header.token, 0x1234_5678);
    }
    let mut broken = raw.clone();
    broken[1] = 0x11;
    broken[9] = 0x22;
    broken[17] = 0x33;
    assert!(matches!(read_frame(&broken), Err(OrpError::InvalidFrame(_))));
}

#[test]
fn corrects_four_errors_per_slice_and_detects_beyond() {
    let payload: Vec<u8> = (0..4 * SYMBOL_SIZE).map(|i| (i * 11) as u8).collect();
    let raw = build_frame(&header(4, FLAG_ENCRYPTED), &payload, Some(&[0; 16])).unwrap();
    let mut damaged = raw.clone();
    for i in 0..4 {
        damaged[24 + i] ^= 0x5a;
    }
    assert_eq!(read_frame(&damaged).unwrap().payload, payload);
    let mut broken = raw.clone();
    for i in 0..5 {
        broken[24 + i * 30] ^= 0x5a;
    }
    assert!(matches!(read_frame(&broken), Err(OrpError::CorruptedFrame { .. })));
}

#[test]
fn rejects_magic_codec_flags_truncation_and_missing_tag() {
    let payload = [0u8; SYMBOL_SIZE];
    let mut magic = build_frame(&header(1, 0), &payload, None).unwrap();
    for c in 0..3 {
        magic[c * 8] = 0;
    }
    assert!(read_frame(&magic).unwrap_err().to_string().contains("magic"));
    let mut codec = build_frame(&header(1, 0), &payload, None).unwrap();
    for c in 0..3 {
        codec[c * 8 + 4] = 0x07;
    }
    assert!(read_frame(&codec).unwrap_err().to_string().contains("codec"));
    assert!(build_frame(&header(1, 0x80), &payload, None).unwrap_err().to_string().contains("flag"));
    let raw = build_frame(&header(1, 0), &payload, None).unwrap();
    assert!(read_frame(&raw[..raw.len() - 1]).is_err());
    assert!(build_frame(&header(2, FLAG_ENCRYPTED), &[0; 192], None)
        .unwrap_err()
        .to_string()
        .contains("tag"));
}

#[test]
fn frozen_capacities_fit_in_grid() {
    assert_eq!(symbol_capacity(Codec::Mono2), 1);
    assert_eq!(symbol_capacity(Codec::Color4), 2);
    assert_eq!(symbol_capacity(Codec::Color8), 4);
    // Grid N = 41: 1423 data modules × bits per module.
    for (codec, bits) in [(Codec::Mono2, 1423), (Codec::Color4, 2 * 1423), (Codec::Color8, 3 * 1423)] {
        assert!(frame_size(symbol_capacity(codec), true) * 8 <= bits);
    }
}

#[test]
fn reed_solomon_corrects_up_to_four_errors() {
    let message: Vec<u8> = (0..247).map(|i| (i * 31 + 5) as u8).collect();
    let mut protected = message.clone();
    protected.extend_from_slice(&rs_parity(&message));
    let mut rng = Mulberry32::new(31);
    for nb in 1..=4 {
        for _ in 0..50 {
            let mut damaged = protected.clone();
            let mut positions = std::collections::BTreeSet::new();
            while positions.len() < nb {
                positions.insert((rng.next_f64() * damaged.len() as f64) as usize);
            }
            for p in positions {
                damaged[p] ^= 0x5a;
            }
            correct_rs(&mut damaged).unwrap();
            assert_eq!(damaged, protected);
        }
    }
    let mut broken = protected.clone();
    for i in 0..6 {
        broken[i * 40] ^= 0x5a;
    }
    assert!(correct_rs(&mut broken).is_err());
    assert_eq!(rs_parity(&[1, 2, 3, 4, 5]), rs_parity(&[1, 2, 3, 4, 5]));
}

// ── fountain.spec.ts ──────────────────────────────────────────────────────

fn random_sources(k: usize) -> Vec<Vec<u8>> {
    let mut rng = Mulberry32::new(1234);
    (0..k).map(|_| random(&mut rng, SYMBOL_SIZE)).collect()
}

#[test]
fn neighbors_deterministic_and_distinct() {
    let a = lt_neighbors(64, 777);
    assert_eq!(a, lt_neighbors(64, 777));
    let distinct: std::collections::HashSet<_> = a.iter().collect();
    assert_eq!(distinct.len(), a.len());
    assert!(a.iter().all(|&v| v < 64));
}

#[test]
fn fountain_rebuilds_despite_losses_and_disorder() {
    let k = 128;
    let sources = random_sources(k);
    let mut d = FountainDecoder::new(k).unwrap();
    let mut sort = Mulberry32::new(99);
    let mut guard: Vec<(u32, Vec<u8>)> = (1..=((k as f64 * 1.7).ceil() as u32))
        .map(|g| (g, fountain_symbol(&sources, k, g).unwrap()))
        .filter(|_| sort.next_f64() > 0.15)
        .collect();
    for i in (1..guard.len()).rev() {
        let j = (sort.next_f64() * (i + 1) as f64) as usize;
        guard.swap(i, j);
    }
    for (g, s) in &guard {
        d.receive(*g, s).unwrap();
    }
    assert!(d.is_complete());
    assert_eq!(d.rebuild().unwrap(), sources);
}

#[test]
fn fountain_ignores_replays_and_unexpected_sizes() {
    let k = 8;
    let sources = random_sources(k);
    let mut d = FountainDecoder::new(k).unwrap();
    let s = fountain_symbol(&sources, k, 1).unwrap();
    d.receive(1, &s).unwrap();
    assert_eq!(d.received_symbols(), 1);
    assert!(!d.receive(1, &s).unwrap());
    assert_eq!(d.received_symbols(), 1);
    assert!(FountainDecoder::new(8).unwrap().receive(1, &[0; 10]).is_err());
    assert!(FountainDecoder::new(0).is_err());
    assert!(FountainDecoder::new(K_MAX + 1).is_err());
}

// ── blocks.spec.ts ────────────────────────────────────────────────────────

#[test]
fn blocks_bounded() {
    assert!(plan_blocks(&[]).symbols.is_empty());
    let un = plan_blocks(&[0]);
    assert_eq!(un.k_per_block, vec![1]);
    assert_eq!(un.symbols[0].len(), SYMBOL_SIZE);
    assert_eq!(assemble(&un.symbols, 1), vec![0]);
    assert_eq!(plan_blocks(&[0; SYMBOL_SIZE]).k_per_block, vec![1]);
    assert_eq!(plan_blocks(&[0; SYMBOL_SIZE - 1]).k_per_block, vec![1]);
    assert_eq!(plan_blocks(&vec![0; K_MAX * SYMBOL_SIZE]).k_per_block, vec![K_MAX]);
    assert_eq!(plan_blocks(&vec![0; K_MAX * SYMBOL_SIZE + 1]).k_per_block, vec![K_MAX, 1]);
}

#[test]
fn blocks_hundred_kb_round_trip() {
    let stream: Vec<u8> = (0..100_000).map(|i| (i * 13 + 7) as u8).collect();
    let plan = plan_blocks(&stream);
    assert_eq!(plan.block_count(), 2);
    assert_eq!(plan.k_total(), 100_000usize.div_ceil(SYMBOL_SIZE));
    assert_eq!(&plan.block_symbols(0).unwrap()[0][..8], &stream[..8]);
    assert_eq!(assemble(&plan.symbols, plan.stream_size), stream);
    let short = vec![0xab; SYMBOL_SIZE + 10];
    let p = plan_blocks(&short);
    assert_eq!(assemble(&p.symbols, p.stream_size), short);
    assert!(plan_blocks(&[0; 10]).block_symbols(5).is_err());
}

// ── encryption.spec.ts ────────────────────────────────────────────────────

#[test]
fn symmetric_ecdh_aead_hkdf_hmac() {
    let mut c = CryptoRust::new();
    let a = c.generate_ecdh_pair().unwrap();
    let b = c.generate_ecdh_pair().unwrap();
    assert_eq!(a.public_key[0], 0x04);
    assert_eq!(
        c.ecdh_agree(&a.private_key, &b.public_key).unwrap(),
        c.ecdh_agree(&b.private_key, &a.public_key).unwrap()
    );
    assert!(c.ecdh_agree(&a.private_key, &[0x04; 65]).is_err());

    let key = c.random_bytes(32);
    let nonce = c.random_bytes(12);
    let plaintext = "configuration.json — contenu secret".as_bytes();
    let (encrypted, tag) = c.encrypt_aead(&key, &nonce, plaintext, &[1, 2, 3]).unwrap();
    assert_eq!(encrypted.len(), plaintext.len());
    assert_eq!(c.decrypt_aead(&key, &nonce, &encrypted, &tag, &[1, 2, 3]).unwrap(), plaintext);
    let mut tampered = tag;
    tampered[0] ^= 1;
    assert!(c.decrypt_aead(&key, &nonce, &encrypted, &tampered, &[1, 2, 3]).is_err());
    assert!(c.decrypt_aead(&key, &nonce, &encrypted, &tag, &[9, 9, 9]).is_err());

    let (secret, salt) = (c.random_bytes(32), c.random_bytes(16));
    let x = c.derive_hkdf(&secret, &salt, "ORP v0.2 donnees", 32).unwrap();
    assert_eq!(x, c.derive_hkdf(&secret, &salt, "ORP v0.2 donnees", 32).unwrap());
    assert_ne!(x, c.derive_hkdf(&secret, &salt, "ORP v0.2 nonce", 32).unwrap());
    assert_eq!(c.hmac_sha256(&key, &[1, 2, 3]), c.hmac_sha256(&key, &[1, 2, 3]));
    assert_ne!(c.random_bytes(16), c.random_bytes(16));
}

/// PBKDF2-HMAC-SHA-256 written by hand (no `pbkdf2` crate): RFC 7914 §11
/// vectors, multi-block output included.
#[test]
fn pbkdf2_hmac_sha256_rfc7914() {
    let c = CryptoRust::new();
    let hex = |s: &str| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect::<Vec<u8>>();
    assert_eq!(
        c.derive_pbkdf2(b"passwd", b"salt", 1, 64).unwrap(),
        hex("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783")
    );
    assert_eq!(
        c.derive_pbkdf2(b"Password", b"NaCl", 80_000, 64).unwrap(),
        hex("4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d")
    );
    // Key longer than a SHA-256 block (hashed first), output truncated.
    let long = [0x61u8; 100];
    let a = c.derive_pbkdf2(&long, b"salt", 2, 20).unwrap();
    assert_eq!(a.len(), 20);
    assert_eq!(a, c.derive_pbkdf2(&c.sha256(&long), b"salt", 2, 20).unwrap());
    assert!(c.derive_pbkdf2(b"x", b"salt", 0, 32).is_err());
}

// ── pairing.spec.ts ───────────────────────────────────────────────────────

fn init_info(c: &mut CryptoRust, stream_size: u64) -> InitCodeInfo {
    let (block_count, k_total) = expected_layout(stream_size);
    InitCodeInfo {
        session_id: c.random_bytes(16),
        commitment: c.random_bytes(32),
        stream_size,
        stream_digest: c.random_bytes(32),
        block_count: block_count as u32,
        k_total: k_total as u32,
        compressed: true,
        by_passphrase: false,
        encrypted: true,
    }
}

#[test]
fn pairing_codes_round_trip_and_sizes() {
    let mut c = CryptoRust::new();
    let mut pub_ = c.random_bytes(65);
    pub_[0] = 0x04;
    let info = init_info(&mut c, 123_456);
    assert_eq!((info.block_count, info.k_total), (2, 1286));
    let init = write_init_code(&info).unwrap();
    assert_eq!((init.len(), init[0], init[1]), (INIT_CODE_SIZE, 0x49, 0x02));
    assert_eq!(INIT_CODE_SIZE, 97);
    assert_eq!(read_init_code(&init).unwrap(), info);
    let response = write_response_code(&info.session_id, &pub_).unwrap();
    assert_eq!((response.len(), response[0], response[1]), (RESPONSE_CODE_SIZE, 0x52, 0x02));
    assert_eq!(read_response_code(&response).unwrap(), ResponseCode { session_id: info.session_id.clone(), receiver_pub: pub_.clone() });
    let reveal = write_reveal_code(&info.session_id, &pub_).unwrap();
    assert_eq!((reveal.len(), reveal[0], reveal[1]), (REVEAL_CODE_SIZE, 0x56, 0x02));
    assert_eq!(read_reveal_code(&reveal).unwrap(), RevealCode { session_id: info.session_id.clone(), sender_pub: pub_.clone() });
    assert_eq!(
        [&init, &response, &reveal, &vec![0x00]].map(|o| pairing_code_kind(o)),
        [Some(PairingCodeKind::Init), Some(PairingCodeKind::Response), Some(PairingCodeKind::Reveal), None]
    );
    // A code of another kind is refused even at the right size.
    assert!(matches!(read_reveal_code(&response), Err(OrpError::InvalidPairingCode(_))));
    assert!(matches!(read_response_code(&reveal), Err(OrpError::InvalidPairingCode(_))));
    assert!(matches!(read_init_code(&[0; 10]), Err(OrpError::InvalidPairingCode(_))));
    assert!(matches!(read_response_code(&[0; 10]), Err(OrpError::InvalidPairingCode(_))));
    assert_eq!(token_of(&[1, 2, 3, 4, 0xff]), 0x0102_0304);
    for flags in 0..8u8 {
        let i = InitCodeInfo { compressed: flags & 1 != 0, by_passphrase: flags & 2 != 0, encrypted: flags & 4 != 0, ..info.clone() };
        let code = write_init_code(&i).unwrap();
        assert_eq!(code[96], flags);
        assert_eq!(read_init_code(&code).unwrap(), i);
    }
}

#[test]
fn pairing_codes_refused() {
    let mut c = CryptoRust::new();
    let info = init_info(&mut c, 5000);
    let code = write_init_code(&info).unwrap();
    let altered = |f: &dyn Fn(&mut Vec<u8>)| {
        let mut o = code.clone();
        f(&mut o);
        read_init_code(&o).map(|_| ()).unwrap_err().code().to_string()
    };
    assert_eq!(altered(&|o| o[1] = 0x01), "version-incompatible", "a v0.1 code is never decoded");
    assert_eq!(altered(&|o| o[96] |= 0x08), "code-appairage-invalide", "unknown flag");
    assert_eq!(altered(&|o| o[95] ^= 1), "code-appairage-invalide", "kTotal ≠ size");
    assert_eq!(altered(&|o| o[91] ^= 2), "code-appairage-invalide", "blockCount ≠ size");
    assert_eq!(altered(&|o| o[50] = 0x01), "code-appairage-invalide", "size > 2⁵³ − 1");
    assert_eq!(altered(&|o| o.truncate(96)), "code-appairage-invalide");
    // The writer refuses an inconsistent layout too (no silent truncation).
    assert!(write_init_code(&InitCodeInfo { k_total: info.k_total + 1, ..info.clone() }).is_err());
    let huge = 65_536 * 1024 * 96;
    let (blocks, k_total) = expected_layout(huge);
    assert!(write_init_code(&InitCodeInfo { stream_size: huge, block_count: blocks as u32, k_total: k_total as u32, ..info.clone() }).is_err());
    // Largest layout: 65 535 blocks, kTotal on 32 bits.
    let max = 65_535 * 1024 * 96;
    let (blocks, k_total) = expected_layout(max);
    let i = InitCodeInfo { stream_size: max, block_count: blocks as u32, k_total: k_total as u32, ..info };
    assert_eq!(read_init_code(&write_init_code(&i).unwrap()).unwrap().k_total, 65_535 * 1024);
}

#[test]
fn expected_k_per_block() {
    assert_eq!(expected_layout(0), (0, 0));
    assert_eq!(expected_layout(1), (1, 1));
    assert_eq!(expected_layout(100_000), (2, 1042));
    assert_eq!((expected_k(100_000, 0), expected_k(100_000, 1), expected_k(100_000, 2)), (1024, 18, 0));
    assert_eq!(expected_k(0, 0), 0);
    assert_eq!(expected_k(96 * 1024, 0), 1024);
    assert_eq!(expected_k(96 * 1024, 1), 0);
}

#[test]
fn key_sas_and_nonce_derivation() {
    let mut c = CryptoRust::new();
    let (secret, transcript) = (c.random_bytes(32), c.random_bytes(32));
    let a = derive_keys(&c, &secret, &transcript).unwrap();
    let b = derive_keys(&c, &secret, &transcript).unwrap();
    assert!(a.sas.len() == 6 && a.sas.bytes().all(|o| o.is_ascii_digit()));
    assert_eq!((&a.sas, &a.data_key, &a.nonce_key), (&b.sas, &b.data_key, &b.nonce_key));
    // Another transcript: everything changes, keys included.
    let mut other_transcript = transcript.clone();
    other_transcript[0] ^= 1;
    let other = derive_keys(&c, &secret, &other_transcript).unwrap();
    assert_ne!(other.data_key, a.data_key);
    assert_ne!(other.nonce_key, a.nonce_key);
    let sid = c.random_bytes(16);
    let s1 = derive_secret_from_passphrase(&c, "mont-blanc-2026", &sid).unwrap();
    assert_eq!(s1.len(), 32);
    let other_sid = c.random_bytes(16);
    assert_ne!(s1, derive_secret_from_passphrase(&c, "mont-blanc-2026", &other_sid).unwrap());
    assert!(matches!(derive_secret_from_passphrase(&c, "court", &sid), Err(OrpError::InvalidPairingCode(_))));
    let key = c.random_bytes(32);
    let n = frame_nonce(&c, &key, 3, 42);
    assert_eq!(n, frame_nonce(&c, &key, 3, 42));
    assert_ne!(n, frame_nonce(&c, &key, 3, 43));
    assert_ne!(n, frame_nonce(&c, &key, 4, 42));
    assert!(constant_time_eq(&[1, 2, 3], &[1, 2, 3]));
    assert!(!constant_time_eq(&[1, 2, 3], &[1, 2, 4]));
    assert!(!constant_time_eq(&[1, 2, 3], &[1, 2]));
}

// ── session.spec.ts ───────────────────────────────────────────────────────

fn crypto() -> Box<CryptoRust> {
    Box::new(CryptoRust::new())
}

fn options(f: impl FnOnce(&mut TransmissionOptions)) -> TransmissionOptions {
    let mut o = TransmissionOptions::default();
    f(&mut o);
    o
}

/// A receiver that accepts a sender in encryption "none" (v0.2: explicit).
fn receiver_accepting_clear() -> ReceiverSession {
    ReceiverSession::with_options(crypto(), ReceptionOptions { encryption: Encryption::Optional, ..ReceptionOptions::default() })
}

/// Pairs two sessions through the strong mode: init → response → reveal.
fn pair(e: &mut SenderSession, r: &mut ReceiverSession) {
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    let response = r.response_code().unwrap();
    assert!(matches!(r.sas(), Err(OrpError::InvalidState { .. })), "no SAS before the reveal code");
    e.receive_response_code(&response).unwrap();
    r.receive_reveal_code(&e.reveal_code().unwrap()).unwrap();
    assert_eq!(e.sas().unwrap(), r.sas().unwrap());
    e.confirm_sas().unwrap();
    r.confirm_sas().unwrap();
}

#[test]
fn session_encrypted_compressed_with_losses_and_disorder() {
    let plaintext: Vec<u8> = (0..24_000).map(|i| (i * 7 + 3) as u8).collect();
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&plaintext).unwrap();
    pair(&mut e, &mut r);
    let complete = Arc::new(Mutex::new(false));
    let flag = complete.clone();
    r.on_event(move |ev| {
        if matches!(ev, ReceiverEvent::Complete { .. }) {
            *flag.lock().unwrap() = true;
        }
    });
    // Channel: 12 % losses, one duplicate, packets of eight shuffled.
    let mut rng = Mulberry32::new(20_261_031);
    let mut waiting: Vec<Vec<u8>> = Vec::new();
    let mut counter = 0;
    e.start(0).unwrap();
    while !*complete.lock().unwrap() {
        let t = e.next_frame().unwrap().unwrap();
        if rng.next_f64() < 0.12 {
            continue;
        }
        waiting.push(t.clone());
        if counter == 3 {
            waiting.push(t);
        }
        counter += 1;
        if counter % 8 == 0 {
            let mut keys: Vec<(f64, Vec<u8>)> = waiting.drain(..).map(|t| (rng.next_f64(), t)).collect();
            keys.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, t) in keys {
                r.receive_frame(&t).unwrap();
            }
        }
    }
    e.finish();
    assert_eq!(e.next_frame().unwrap(), None);
    assert_eq!(e.state(), SessionState::Finished);
    let res = r.result().unwrap();
    assert!(res.checked);
    assert_eq!(res.data, plaintext);
    let p = r.progress();
    assert_eq!(p.completed_blocks, p.block_count);
    assert!(p.replays > 0);
}

#[test]
fn session_by_passphrase_without_encryption_or_compression() {
    let message = "Plain test message — UC-01, without encryption.".as_bytes();
    let mut e = SenderSession::new(
        crypto(),
        options(|o| {
            o.encryption = Encryption::Disabled;
            o.compression = false;
            o.pairing = PairingMode::Passphrase;
        }),
    )
    .unwrap();
    let mut r = receiver_accepting_clear();
    e.prepare(message).unwrap();
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    r.pair_by_passphrase("shared-pairing-passphrase").unwrap();
    e.receive_passphrase("shared-pairing-passphrase").unwrap();
    assert_eq!(e.sas().unwrap(), r.sas().unwrap());
    e.confirm_sas().unwrap();
    r.confirm_sas().unwrap();
    e.send_all(1, |_, t| r.receive_frame(&t).map(|_| ())).unwrap();
    assert_eq!(r.result().unwrap().data, message);
}

#[test]
fn session_by_announced_passphrase_same_sas() {
    let mut e = SenderSession::new(crypto(), options(|o| o.pairing = PairingMode::Passphrase)).unwrap();
    e.prepare(b"hello").unwrap();
    let mut r = ReceiverSession::new(crypto());
    assert!(r.show_init_code(&e.init_code().unwrap()).unwrap().by_passphrase);
    e.receive_passphrase("shared test passphrase").unwrap();
    r.pair_by_passphrase("shared test passphrase").unwrap();
    assert_eq!(r.sas().unwrap(), e.sas().unwrap());
}

#[test]
fn session_codec_fallback_mid_transfer() {
    let plaintext: Vec<u8> = (0..60_000).map(|i| (i * 5) as u8).collect();
    let mut e = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&plaintext).unwrap();
    pair(&mut e, &mut r);
    let codecs = Arc::new(Mutex::new(Vec::new()));
    let c = codecs.clone();
    e.on_event(move |ev| {
        if let SenderEvent::Frame { codec, .. } = ev {
            c.lock().unwrap().push(*codec);
        }
    });
    let mut n = 0;
    e.send_all(0, |em, t| {
        n += 1;
        if n == 120 {
            em.change_codec(Codec::Color4)?;
        }
        r.receive_frame(&t)?;
        if r.finished() {
            em.finish();
        }
        Ok(())
    })
    .unwrap();
    let codecs = codecs.lock().unwrap();
    assert!(codecs[..120].iter().all(|&c| c == Codec::Color8));
    assert!(codecs[120..].contains(&Codec::Color4));
    assert_eq!(r.result().unwrap().data, plaintext);
}

/// Sends one pass and returns the frames.
fn single_pass(e: &mut SenderSession) -> Vec<Vec<u8>> {
    let mut buffer = Vec::new();
    e.send_all(1, |_, t| {
        buffer.push(t);
        Ok(())
    })
    .unwrap();
    buffer
}

#[test]
fn session_replay_and_forged_frame() {
    let mut e = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&[0x42; 5000]).unwrap();
    pair(&mut e, &mut r);
    let buffer = single_pass(&mut e);
    assert!(buffer.len() > 2);
    assert_eq!(r.receive_frame(&buffer[0]).unwrap(), FrameStatus::Accepted);
    assert_eq!(r.receive_frame(&buffer[0]).unwrap(), FrameStatus::Rejected(Rejection::Replay));
    // Forgery: header copied (other seed), valid RS and CRC — only the AEAD unmasks it.
    let model = read_frame(&buffer[1]).unwrap();
    let forged_header = FrameHeader { seed: 0xdead_beef, ..model.header };
    let forged = build_frame(&forged_header, &vec![0x5a; model.payload.len()], Some(&[0x5a; 16])).unwrap();
    assert_eq!(r.receive_frame(&forged).unwrap(), FrameStatus::Rejected(Rejection::Forged));
}

#[test]
fn unknown_session_rejected() {
    let mut e = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&[7; 5000]).unwrap();
    pair(&mut e, &mut r);
    let buffer = single_pass(&mut e);
    let mut e2 = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    e2.prepare(&[7; 5000]).unwrap();
    let mut r2 = ReceiverSession::new(crypto());
    pair(&mut e2, &mut r2);
    assert!(matches!(r2.receive_frame(&buffer[0]), Err(OrpError::UnknownSession(_))));
}

#[test]
fn session_incompatible_major_version() {
    let mut e = SenderSession::new(
        crypto(),
        options(|o| {
            o.compression = false;
            o.encryption = Encryption::Disabled;
        }),
    )
    .unwrap();
    let mut r = receiver_accepting_clear();
    e.prepare(&[0; 4000]).unwrap();
    pair(&mut e, &mut r);
    let buffer = single_pass(&mut e);
    let model = read_frame(&buffer[0]).unwrap();
    let too_recent = build_frame(
        &FrameHeader { version: Version { major: 1, minor: 0 }, ..model.header },
        &model.payload,
        model.tag.as_deref(),
    )
    .unwrap();
    assert_eq!(r.receive_frame(&too_recent).unwrap(), FrameStatus::Rejected(Rejection::Version));
}

#[test]
fn session_state_machine() {
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    assert!(matches!(e.init_code(), Err(OrpError::PairingRequired(_))));
    e.prepare(&[0; 1000]).unwrap();
    assert!(matches!(e.start(0), Err(OrpError::InvalidState { .. })));
    assert!(matches!(e.sas(), Err(OrpError::InvalidState { .. })));
    assert!(matches!(e.prepare(&[0; 10]), Err(OrpError::InvalidState { .. })));
    let mut r = ReceiverSession::new(crypto());
    assert!(matches!(r.sas(), Err(OrpError::InvalidState { .. })));
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    assert!(SenderSession::new(crypto(), options(|o| o.codecs.clear())).is_err());
}

#[test]
fn session_pause_resume_cancel() {
    let plaintext = vec![0x11; 30_000];
    let mut e = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&plaintext).unwrap();
    pair(&mut e, &mut r);
    e.start(0).unwrap();
    while !r.finished() {
        if e.sent_frames() == 50 {
            e.pause().unwrap();
            assert_eq!(e.state(), SessionState::Pause);
            assert!(e.next_frame().is_err(), "while paused, no frame goes out");
            e.change_codec(Codec::Mono2).unwrap();
            e.resume().unwrap();
        }
        let t = e.next_frame().unwrap().unwrap();
        r.receive_frame(&t).unwrap();
    }
    assert_eq!(r.result().unwrap().data, plaintext);
    // Cancel while paused: end "annule", keys wiped.
    e.pause().unwrap();
    let end_reasons = Arc::new(Mutex::new(Vec::new()));
    let f = end_reasons.clone();
    e.on_event(move |ev| {
        if let SenderEvent::End { reason } = ev {
            f.lock().unwrap().push(*reason);
        }
    });
    e.cancel();
    assert_eq!(e.next_frame().unwrap(), None);
    assert_eq!(e.next_frame().unwrap(), None);
    assert_eq!(e.state(), SessionState::Cancelled);
    assert_eq!(*end_reasons.lock().unwrap(), vec![EndReason::Cancelled]);
    assert!(e.init_code().is_err(), "dispose wiped the plan");
}

#[test]
fn session_empty_stream_finishes() {
    let mut e = SenderSession::new(crypto(), options(|o| o.encryption = Encryption::Disabled)).unwrap();
    let mut r = receiver_accepting_clear();
    e.prepare(&[]).unwrap();
    pair(&mut e, &mut r);
    assert!(single_pass(&mut e).is_empty());
    e = SenderSession::new(crypto(), options(|o| o.encryption = Encryption::Disabled)).unwrap();
    e.prepare(&[]).unwrap();
    r = receiver_accepting_clear();
    pair(&mut e, &mut r);
    e.start(0).unwrap();
    assert_eq!(e.next_frame().unwrap(), None, "passes = 0 on an empty stream: no endless loop");
    // Zero announced blocks: the receiver is complete from the start (but, as
    // in TS, `result` requires having seen the transmission go by).
    assert!(r.finished());
}

// ── security.spec.ts (ORP v0.2) ───────────────────────────────────────────

/// Encrypted session paired by codes, one pass of 2 sent.
fn paired(file: &[u8]) -> (SenderSession, ReceiverSession, Vec<Vec<u8>>) {
    let mut e = SenderSession::new(crypto(), options(|o| o.compression = false)).unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(file).unwrap();
    pair(&mut e, &mut r);
    let mut frames = Vec::new();
    e.send_all(2, |_, t| {
        frames.push(t);
        Ok(())
    })
    .unwrap();
    (e, r, frames)
}

/// A clear frame of the session: the token is readable on the wire, nothing else is needed.
fn clear_frame(token: u32, block: u32, k: u16, seed: u32) -> Vec<u8> {
    build_frame(
        &FrameHeader { version: FRAME_VERSION, codec: Codec::Color8, flags: 0, token, block, k, symbol_count: 1, seed },
        &[0x41; 96],
        None,
    )
    .unwrap()
}

#[test]
fn clear_frame_in_encrypted_session_is_forged() {
    let file: Vec<u8> = (0..500).map(|i| i as u8).collect();
    let (e, mut r, frames) = paired(&file);
    let k = 500usize.div_ceil(96) as u16;
    assert_eq!(r.receive_frame(&clear_frame(e.token(), 0, k, 1)).unwrap(), FrameStatus::Rejected(Rejection::Forged));
    for t in &frames {
        r.receive_frame(t).unwrap();
    }
    assert_eq!(r.result().unwrap().data, file);
    assert_eq!(r.progress().forged, 1);
}

#[test]
fn frame_outside_layout_is_invalid_before_decoding() {
    let (e, mut r, frames) = paired(&[0; 500]);
    assert_eq!(r.receive_frame(&clear_frame(e.token(), 123_456, 6, 1)).unwrap(), FrameStatus::Rejected(Rejection::Invalid));
    assert_eq!(r.receive_frame(&clear_frame(e.token(), 0, 999, 1)).unwrap(), FrameStatus::Rejected(Rejection::Invalid));
    assert_eq!(r.progress().received_symbols, 0);
    assert!(r.blocks().iter().all(|b| b.k == 6));
    // Encrypted frame whose header was rewritten to another K.
    let original = read_frame(&frames[0]).unwrap();
    let forged = build_frame(&FrameHeader { k: original.header.k + 1, ..original.header }, &original.payload, original.tag.as_deref()).unwrap();
    assert_eq!(r.receive_frame(&forged).unwrap(), FrameStatus::Rejected(Rejection::Invalid));
}

#[test]
fn receiver_refuses_clear_sender_unless_accepted() {
    let mut e = SenderSession::new(crypto(), options(|o| {
        o.encryption = Encryption::Disabled;
        o.pairing = PairingMode::Passphrase;
    }))
    .unwrap();
    e.prepare(&[0; 10]).unwrap();
    let init = e.init_code().unwrap();
    assert!(matches!(ReceiverSession::new(crypto()).show_init_code(&init), Err(OrpError::InvalidPairingCode(_))));
    assert!(!receiver_accepting_clear().show_init_code(&init).unwrap().encrypted);
}

#[test]
fn altered_init_code_gives_diverging_sas() {
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    e.prepare(&[7; 1000]).unwrap();
    let mut altered = e.init_code().unwrap();
    altered[60] ^= 0xff; // stream digest
    let mut r = ReceiverSession::new(crypto());
    r.show_init_code(&altered).unwrap();
    e.receive_response_code(&r.response_code().unwrap()).unwrap();
    r.receive_reveal_code(&e.reveal_code().unwrap()).unwrap();
    assert_ne!(r.sas().unwrap(), e.sas().unwrap());
}

#[test]
fn man_in_the_middle_cannot_reveal_another_key() {
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    e.prepare(&[0; 100]).unwrap();
    assert!(matches!(e.reveal_code(), Err(OrpError::PairingRequired(_))), "no reveal code before the response");
    let mut r = ReceiverSession::new(crypto());
    let info = r.show_init_code(&e.init_code().unwrap()).unwrap();
    assert!(matches!(r.receive_reveal_code(&[0; REVEAL_CODE_SIZE]), Err(OrpError::PairingRequired(_))));
    let response = r.response_code().unwrap();
    assert_eq!(r.response_code().unwrap(), response, "same response code on every call");
    // The attacker relays the real init code, then reveals ITS key.
    let attacker = CryptoRust::new().generate_ecdh_pair().unwrap();
    let forged = write_reveal_code(&info.session_id, &attacker.public_key).unwrap();
    assert!(matches!(r.receive_reveal_code(&forged), Err(OrpError::InvalidPairingCode(_))));
    assert_eq!(r.state(), SessionState::Pairing);
    // The real reveal code still goes through.
    e.receive_response_code(&response).unwrap();
    r.receive_reveal_code(&e.reveal_code().unwrap()).unwrap();
    assert_eq!(r.sas().unwrap(), e.sas().unwrap());
}

#[test]
fn pairing_mode_must_match_the_init_code() {
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    e.prepare(&[0; 100]).unwrap();
    assert!(matches!(e.receive_passphrase("shared test passphrase"), Err(OrpError::InvalidState { .. })));
    let mut r = ReceiverSession::new(crypto());
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    assert!(matches!(r.pair_by_passphrase("shared test passphrase"), Err(OrpError::InvalidState { .. })));

    let mut e = SenderSession::new(crypto(), options(|o| o.pairing = PairingMode::Passphrase)).unwrap();
    e.prepare(&[0; 100]).unwrap();
    let mut r = ReceiverSession::new(crypto());
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    assert!(matches!(r.response_code(), Err(OrpError::InvalidState { .. })));
    let mut other = ReceiverSession::new(crypto());
    let mut codes = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    codes.prepare(&[0; 100]).unwrap();
    other.show_init_code(&codes.init_code().unwrap()).unwrap();
    assert!(matches!(e.receive_response_code(&other.response_code().unwrap()), Err(OrpError::InvalidState { .. })));
    // Different passphrases: different SAS.
    e.receive_passphrase("shared test passphrase").unwrap();
    r.pair_by_passphrase("another test passphrase").unwrap();
    assert_ne!(r.sas().unwrap(), e.sas().unwrap());
}

#[test]
fn finished_state_survives_late_frames() {
    let file = vec![3u8; 700];
    let (_, mut r, frames) = paired(&file);
    for t in &frames {
        r.receive_frame(t).unwrap();
    }
    assert_eq!(r.result().unwrap().data, file);
    assert_eq!(r.state(), SessionState::Finished);
    r.receive_frame(&frames[0]).unwrap();
    assert_eq!(r.state(), SessionState::Finished, "a late frame does not reopen the transmission");
}

#[test]
fn deflate_bomb_stopped_at_the_bound() {
    use orp_core::compression::{compress, decompress, decompress_bounded};
    let bomb = compress(&vec![0; 4 * 1024 * 1024]).unwrap();
    assert_eq!(decompress_bounded(&bomb, 1024 * 1024).unwrap_err().code(), "taille-excessive");
    assert_eq!(decompress_bounded(&bomb, 4 * 1024 * 1024).unwrap().len(), 4 * 1024 * 1024);
    assert_eq!(decompress(&bomb).unwrap().len(), 4 * 1024 * 1024);
    assert!(decompress(&[0xff, 0xff, 0xff, 0xff]).is_err());
    // Through a session: the receiver bound applies to the delivered file.
    let file = vec![0u8; 200_000];
    let mut e = SenderSession::new(crypto(), TransmissionOptions::default()).unwrap();
    let mut r = ReceiverSession::with_options(crypto(), ReceptionOptions { max_file_size: 100_000, ..ReceptionOptions::default() });
    e.prepare(&file).unwrap();
    pair(&mut e, &mut r);
    e.send_all(0, |em, t| {
        r.receive_frame(&t)?;
        if r.finished() {
            em.finish();
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(r.result().unwrap_err().code(), "taille-excessive");
}

// ── efficiency.spec.ts ────────────────────────────────────────────────────

fn frames_needed(size: usize, codec: Codec) -> (usize, usize) {
    let mut rng = Mulberry32::new(size as u32);
    let file = random(&mut rng, size);
    let mut e = SenderSession::new(
        crypto(),
        options(|o| {
            o.codecs = vec![codec];
            o.compression = false;
        }),
    )
    .unwrap();
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&file).unwrap();
    pair(&mut e, &mut r);
    let mut frames = 0;
    e.send_all(0, |em, t| {
        frames += 1;
        r.receive_frame(&t)?;
        if r.finished() || frames > 2000 {
            em.finish();
        }
        Ok(())
    })
    .unwrap();
    assert!(r.finished());
    (frames, size.div_ceil(SYMBOL_SIZE))
}

#[test]
fn fountain_code_efficiency_per_frame() {
    for (codec, per_frame) in [(Codec::Color8, 4.0), (Codec::Color4, 2.0)] {
        let (frames, k) = frames_needed(19_200, codec);
        assert!(frames as f64 <= (1.1 * k as f64 / per_frame).ceil() + 1.0, "{codec:?} large block: {frames}");
        let (frames, k) = frames_needed(6000, codec);
        assert!(frames as f64 <= (1.8 * k as f64 / per_frame).ceil(), "{codec:?} small block: {frames}");
    }
}
