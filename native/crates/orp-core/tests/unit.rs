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
    let x = c.derive_hkdf(&secret, &salt, "ORP v0.1 donnees", 32).unwrap();
    assert_eq!(x, c.derive_hkdf(&secret, &salt, "ORP v0.1 donnees", 32).unwrap());
    assert_ne!(x, c.derive_hkdf(&secret, &salt, "ORP v0.1 nonce", 32).unwrap());
    assert_eq!(c.hmac_sha256(&key, &[1, 2, 3]), c.hmac_sha256(&key, &[1, 2, 3]));
    assert_ne!(c.random_bytes(16), c.random_bytes(16));
}

// ── pairing.spec.ts ───────────────────────────────────────────────────────

#[test]
fn pairing_codes_round_trip_and_sizes() {
    let mut c = CryptoRust::new();
    let mut pub_ = c.random_bytes(65);
    pub_[0] = 0x04;
    let info = InitCodeInfo {
        session_id: c.random_bytes(16),
        sender_pub: pub_.clone(),
        stream_size: 123_456,
        stream_digest: c.random_bytes(32),
        block_count: 2,
        k_total: 1500,
        compressed: true,
        by_passphrase: false,
    };
    assert_eq!(read_init_code(&write_init_code(&info).unwrap()).unwrap(), info);
    let rep = read_response_code(&write_response_code(&info.session_id, &pub_, 424_242).unwrap()).unwrap();
    assert_eq!((rep.receiver_pub, rep.sas_seed), (pub_, 424_242));
    assert!(matches!(read_init_code(&[0; 10]), Err(OrpError::InvalidPairingCode(_))));
    assert!(matches!(read_response_code(&[0; 10]), Err(OrpError::InvalidPairingCode(_))));
    assert_eq!(token_of(&[1, 2, 3, 4, 0xff]), 0x0102_0304);
    for compressed in [false, true] {
        for by_passphrase in [false, true] {
            let i = InitCodeInfo { compressed, by_passphrase, ..info.clone() };
            let decoded = read_init_code(&write_init_code(&i).unwrap()).unwrap();
            assert_eq!((decoded.compressed, decoded.by_passphrase), (compressed, by_passphrase));
        }
    }
}

#[test]
fn key_sas_and_nonce_derivation() {
    let mut c = CryptoRust::new();
    let (secret, sid) = (c.random_bytes(32), c.random_bytes(16));
    let a = derive_keys(&c, &secret, &sid, 777).unwrap();
    let b = derive_keys(&c, &secret, &sid, 777).unwrap();
    assert!(a.sas.len() == 6 && a.sas.bytes().all(|o| o.is_ascii_digit()));
    assert_eq!((&a.sas, &a.data_key), (&b.sas, &b.data_key));
    let other = derive_keys(&c, &secret, &sid, 778).unwrap();
    assert_ne!(other.sas, a.sas);
    assert_eq!(other.data_key, a.data_key);
    assert!(derive_secret_from_passphrase(&c, "mont-blanc-2026", &sid).is_ok());
    assert!(matches!(derive_secret_from_passphrase(&c, "court", &sid), Err(OrpError::InvalidPairingCode(_))));
    let key = c.random_bytes(32);
    let n = frame_nonce(&c, &key, 3, 42);
    assert_eq!(n, frame_nonce(&c, &key, 3, 42));
    assert_ne!(n, frame_nonce(&c, &key, 3, 43));
    assert_ne!(n, frame_nonce(&c, &key, 4, 42));
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

/// Pairs two sessions through the strong mode.
fn pair(e: &mut SenderSession, r: &mut ReceiverSession) {
    r.show_init_code(&e.init_code().unwrap()).unwrap();
    let response = r.response_code().unwrap();
    e.receive_response_code(&response).unwrap();
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
        }),
    )
    .unwrap();
    let mut r = ReceiverSession::new(crypto());
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
    let mut r = ReceiverSession::new(crypto());
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
    let mut r = ReceiverSession::new(crypto());
    e.prepare(&[]).unwrap();
    pair(&mut e, &mut r);
    assert!(single_pass(&mut e).is_empty());
    e = SenderSession::new(crypto(), options(|o| o.encryption = Encryption::Disabled)).unwrap();
    e.prepare(&[]).unwrap();
    r = ReceiverSession::new(crypto());
    pair(&mut e, &mut r);
    e.start(0).unwrap();
    assert_eq!(e.next_frame().unwrap(), None, "passes = 0 on an empty stream: no endless loop");
    // Zero announced blocks: the receiver is complete from the start (but, as
    // in TS, `result` requires having seen the transmission go by).
    assert!(r.finished());
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
