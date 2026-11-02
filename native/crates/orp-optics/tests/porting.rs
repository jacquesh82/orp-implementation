//! Port of the TypeScript tests of `packages/optical/test/` (temporel,
//! recepteur-tm, mosaique, optique): same scenarios, same expectations.
//! (optical-acceptance.spec.ts, which goes through a complete encrypted ORP
//! session, belongs to the orp-core session.)

mod common;

use std::collections::HashSet;

use common::*;
use orp_core::frames::frame_size;
use orp_core::{read_frame, Codec, FrameHeader, SYMBOL_SIZE, FRAME_VERSION};
use orp_optics::*;

const N: usize = GRID_SIZE;

fn errors(expected: &[u8], decoded: &[u8]) -> usize {
    expected
        .iter()
        .enumerate()
        .filter(|&(i, a)| decoded.get(i) != Some(a))
        .count()
}

/// Captures R then P — INDEPENDENT noise between the two (seed + 1).
fn capture(
    raw: &[u8],
    codec: Codec,
    options: &SimulationOptions,
    options_p: Option<SimulationOptions>,
) -> (ImageRGBA, ImageRGBA) {
    let op = options_p.unwrap_or_else(|| SimulationOptions {
        seed: options.seed + 1,
        ..options.clone()
    });
    (
        simulate_capture(
            &reference_subframe(raw, codec).unwrap(),
            &PALETTE_TM,
            options,
        ),
        simulate_capture(&payload_subframe(raw, codec).unwrap(), &PALETTE_TM, &op),
    )
}

fn hostile() -> SimulationOptions {
    SimulationOptions {
        rotation_degrees: 4.0,
        gains: [1.4, 0.65, 1.2],
        noise: 7.0,
        seed: 5,
        veil: [30.0, -15.0, 10.0],
        ..Default::default()
    }
}

// ── temporal.spec.ts ──────────────────────────────────────────────────────

#[test]
fn subframes_r_and_p() {
    let raw = test_frame(Codec::Color8);
    let r = reference_subframe(&raw, Codec::Color8).unwrap();
    let p = payload_subframe(&raw, Codec::Color8).unwrap();
    let [ax, ay] = TM_ALIGNMENT;
    assert_eq!(r[3 * N + 3], 0);
    assert_eq!(r[ay * N + ax], 0); // black center
    assert_eq!(r[ay * N + ax + 1], 1); // white ring
    assert_eq!(r[ay * N + ax + 2], 0); // black ring
    assert_eq!(p[ay * N + ax], 0);
    assert_eq!(r[10 * N + 10], 2);
    assert!(p[10 * N + 10] >= 3);
    let pilots: HashSet<u8> = (0..8).map(|i| p[40 * N + 8 + i]).collect();
    assert_eq!(pilots.len(), 8);
}

#[test]
fn direction_index() {
    assert_eq!(
        PALETTE_TM[index_direction(1, 0, 1) as usize],
        [192, 64, 192]
    );
    assert_eq!(PALETTE_TM[index_direction(0, 1, 0) as usize], [64, 192, 64]);
}

#[test]
fn tm4_sends_only_even_parity() {
    let p = payload_subframe(&test_frame(Codec::Color4), Codec::Color4).unwrap();
    let mut seen_values: Vec<u8> = tm_data_modules()
        .iter()
        .map(|&[x, y]| p[y * N + x] - 3)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    seen_values.sort();
    assert_eq!(seen_values, vec![0, 3, 5, 6]);
}

#[test]
fn tm_pair_capacity() {
    assert_eq!(tm_data_modules().len(), 1398);
    assert!(tm_capacity(Codec::Color8).unwrap() >= frame_size(4, true));
    assert!(tm_capacity(Codec::Color4).unwrap() >= frame_size(2, true));
    assert!(bits_tm(Codec::Mono2).is_err());
    let too = vec![0u8; tm_capacity(Codec::Color4).unwrap() + 1];
    assert!(payload_subframe(&too, Codec::Color4).is_err());
}

#[test]
fn tm_test_pattern_is_deterministic() {
    assert_eq!(
        tm_test_pattern(Codec::Color8, TEST_PATTERN_SEED).unwrap(),
        tm_test_pattern(Codec::Color8, TEST_PATTERN_SEED).unwrap()
    );
}

#[test]
fn hostile_channel_gains_veil_rotation_noise() {
    for codec in [Codec::Color8, Codec::Color4] {
        let raw = test_frame(codec);
        let (r, p) = capture(&raw, codec, &hostile(), None);
        let d = decoder_tm(&r, &p, codec).unwrap();
        assert_eq!(
            errors(&raw, &d.decision.bytes),
            0,
            "{codec:?}: gains {:?}",
            d.measurement.gains
        );
        assert!(d.decision.mean_confidence > 0.4);
        assert!(read_frame(&d.decision.bytes).is_ok());
    }
}

#[test]
fn perspective_homography_from_alignment_pattern() {
    for codec in [Codec::Color8, Codec::Color4] {
        let raw = test_frame(codec);
        let options = SimulationOptions {
            perspective: [0.15, -0.1],
            scale: 0.75,
            rotation_degrees: 6.0,
            noise: 5.0,
            seed: 9,
            module_size: 10,
            ..Default::default()
        };
        let (r, p) = capture(&raw, codec, &options, None);
        let d = decoder_tm(&r, &p, codec).unwrap();
        assert!(d.location.alignment.is_some());
        assert!(d.location.perspective_gap > 5.0);
        assert_eq!(errors(&raw, &d.decision.bytes), 0);
        // Control: the affine alone reads the grid off target.
        let aff_r = locate(&r, None, None).unwrap();
        let aff_p = locate(&p, None, Some(&aff_r)).unwrap();
        let witness = decide_tm(
            &measure_tm_pair(
                &analyze_subframe(&r, &aff_r),
                &analyze_subframe(&p, &aff_p),
            )
            .soft,
            codec,
        )
        .unwrap();
        assert!(errors(&raw, &witness.bytes) > raw.len() / 2);
    }
}

#[test]
fn crosstalk_and_different_exposure_between_r_and_p() {
    let matrix = [[0.75, 0.3, -0.12], [0.28, 0.7, 0.18], [-0.1, 0.32, 0.72]];
    for codec in [Codec::Color8, Codec::Color4] {
        let raw = test_frame(codec);
        let o_r = SimulationOptions {
            matrix: Some(matrix),
            gains: [1.1, 1.0, 0.9],
            veil: [12.0, 8.0, 20.0],
            noise: 5.0,
            seed: 3,
            ..Default::default()
        };
        let o_p = SimulationOptions {
            matrix: Some(matrix),
            gains: [0.85, 0.95, 1.1],
            veil: [25.0, 0.0, 5.0],
            noise: 5.0,
            seed: 4,
            ..Default::default()
        };
        let (r, p) = capture(&raw, codec, &o_r, Some(o_p));
        let d = decoder_tm(&r, &p, codec).unwrap();
        assert!(d.measurement.full_matrix);
        assert!(d.measurement.crosstalk > 0.2);
        assert_eq!(errors(&raw, &d.decision.bytes), 0);
    }
}

#[test]
fn rotated_phone_marker_order_by_cross_product() {
    for codec in [Codec::Color8, Codec::Color4] {
        let raw = test_frame(codec);
        for rotation in [90u32, 180, 233] {
            let options = SimulationOptions {
                rotation_degrees: rotation as f64,
                scale: 0.7,
                noise: 4.0,
                seed: rotation,
                module_size: 12,
                ..Default::default()
            };
            let (r, p) = capture(&raw, codec, &options, None);
            let d = decoder_tm(&r, &p, codec).unwrap();
            assert_eq!(
                errors(&raw, &d.decision.bytes),
                0,
                "rotation {rotation}°"
            );
        }
    }
}

#[test]
fn tm4_resists_strong_noise_better_than_tm8() {
    let options = SimulationOptions {
        gains: [1.3, 0.55, 1.15],
        noise: 60.0,
        seed: 40,
        ..Default::default()
    };
    let read = |codec: Codec| {
        let raw = test_frame(codec);
        let (r, p) = capture(&raw, codec, &options, None);
        let d = decoder_tm(&r, &p, codec).unwrap();
        (
            errors(&raw, &d.decision.bytes),
            d.decision.uncertain_fraction,
        )
    };
    let (e8, i8) = read(Codec::Color8);
    let (e4, i4) = read(Codec::Color4);
    assert!(e8 > 10);
    assert!((e4 as f64) < e8 as f64 / 5.0);
    assert!(i4 < i8);
}

#[test]
fn classify_r_p_and_mixed() {
    let raw = test_frame(Codec::Color8);
    let options = SimulationOptions {
        gains: [1.2, 0.9, 1.1],
        noise: 4.0,
        ..Default::default()
    };
    let (r, p) = capture(&raw, Codec::Color8, &options, None);
    let loc = locate_tm(&r, None).unwrap();
    assert_eq!(analyze_subframe(&r, &loc).type_, SubframeKind::R);
    assert_eq!(
        analyze_subframe(&p, &locate_tm(&p, None).unwrap()).type_,
        SubframeKind::P
    );
    let mut mixed = r.clone();
    let cut = (r.height / 2) * r.width * 4;
    mixed.data[cut..].copy_from_slice(&p.data[cut..]);
    assert_eq!(
        analyze_subframe(&mixed, &loc).type_,
        SubframeKind::Mixed
    );
}

#[test]
fn soft_accumulation_over_several_pairs() {
    let codec = Codec::Color8;
    let raw = test_frame(codec);
    let mut accumulation = vec![0f32; tm_data_modules().len() * 3];
    let mut best_fit = usize::MAX;
    for trial in 0..4u32 {
        let o = SimulationOptions {
            gains: [1.2, 0.6, 1.1],
            noise: 45.0,
            module_size: 6,
            ..Default::default()
        };
        let (r, p) = capture(
            &raw,
            codec,
            &SimulationOptions {
                seed: 100 + trial * 2,
                ..o.clone()
            },
            Some(SimulationOptions {
                seed: 101 + trial * 2,
                ..o
            }),
        );
        let loc_r = locate_tm(&r, None).unwrap();
        let measurement = measure_tm_pair(
            &analyze_subframe(&r, &loc_r),
            &analyze_subframe(&p, &locate_tm(&p, Some(&loc_r)).unwrap()),
        );
        best_fit = best_fit.min(errors(
            &raw,
            &decide_tm(&measurement.soft, codec).unwrap().bytes,
        ));
        for (c, s) in accumulation.iter_mut().zip(&measurement.soft) {
            *c = (*c as f64 + *s as f64) as f32;
        }
    }
    let accumulated = errors(&raw, &decide_tm(&accumulation, codec).unwrap().bytes);
    assert!(best_fit > 0);
    assert!(accumulated < best_fit);
}

// ── tm-receiver.spec.ts ───────────────────────────────────────────────────

#[test]
fn receiver_scrolling_frames() {
    for codec in [Codec::Color8, Codec::Color4] {
        let frames: Vec<Vec<u8>> = [11, 12, 13].iter().map(|&g| stream_frame(codec, g)).collect();
        let options = SimulationOptions {
            rotation_degrees: 3.0,
            gains: [1.2, 0.8, 1.1],
            noise: 5.0,
            perspective: [0.08, 0.0],
            scale: 0.85,
            ..Default::default()
        };
        let mut receiver = TmReceiver::default();
        let mut received: Vec<Vec<u8>> = Vec::new();
        let (mut t, mut seed) = (0.0, 1);
        for raw in &frames {
            for grid in [
                reference_subframe(raw, codec).unwrap(),
                payload_subframe(raw, codec).unwrap(),
            ] {
                t += 250.0;
                let r = receiver.process(
                    &simulate_capture(
                        &grid,
                        &PALETTE_TM,
                        &SimulationOptions {
                            seed,
                            ..options.clone()
                        },
                    ),
                    t,
                );
                seed += 1;
                if let Some(tr) = r.frame.filter(|tr| tr.is_new) {
                    assert_eq!(tr.codec, codec);
                    received.push(tr.bytes);
                }
            }
        }
        assert_eq!(received.len(), 3);
        for (b, decoded) in frames.iter().zip(&received) {
            assert_eq!(&decoded[..b.len()], &b[..]);
        }
        assert_eq!(receiver.stats.mixed_count, 0);
    }
}

#[test]
fn receiver_rejects_a_pair_too_far_apart() {
    let raw = stream_frame(Codec::Color8, 3);
    let mut receiver = TmReceiver::new(&TmReceiverOptions {
        validity_duration: 500.0,
        ..Default::default()
    });
    let o = SimulationOptions::default();
    receiver.process(
        &simulate_capture(
            &reference_subframe(&raw, Codec::Color8).unwrap(),
            &PALETTE_TM,
            &o,
        ),
        0.0,
    );
    let r = receiver.process(
        &simulate_capture(
            &payload_subframe(&raw, Codec::Color8).unwrap(),
            &PALETTE_TM,
            &o,
        ),
        2000.0,
    );
    assert!(r.frame.is_none());
}

#[test]
fn still_camera_geometry_does_not_jump() {
    let options = SimulationOptions {
        rotation_degrees: 4.0,
        noise: 10.0,
        perspective: [0.12, 0.05],
        scale: 0.85,
        blur: 1,
        gains: [1.2, 0.85, 1.1],
        veil: [20.0, 20.0, 25.0],
        ..Default::default()
    };
    let mut receiver = TmReceiver::default();
    let (mut t, mut seed) = (0.0, 1);
    let (mut pairs, mut valid_count, mut jump) = (0, 0, 0f64);
    let mut before: Option<[f64; 2]> = None;
    for i in 0..30 {
        let raw = stream_frame(Codec::Color8, 100 + i);
        for grid in [
            reference_subframe(&raw, Codec::Color8).unwrap(),
            payload_subframe(&raw, Codec::Color8).unwrap(),
        ] {
            let image = simulate_capture(
                &grid,
                &PALETTE_TM,
                &SimulationOptions {
                    seed,
                    ..options.clone()
                },
            );
            seed += 1;
            let locs = locate_all(&image, Some(TM_ALIGNMENT), 16);
            t += 150.0;
            let r = match locs.first() {
                Some(l) => receiver.process_located(&image, l, t, true),
                None => receiver.process(&image, t),
            };
            let loc = r.location.unwrap();
            assert!(loc.alignment.is_some());
            if let Some(a) = before {
                jump = jump.max(js::hypot(
                    loc.markers[0][0] - a[0],
                    loc.markers[0][1] - a[1],
                ));
            }
            before = Some(loc.markers[0]);
            if r.frame.is_some() || r.invalid_pair {
                pairs += 1;
            }
            if r.frame.is_some() {
                valid_count += 1;
            }
        }
    }
    assert!(jump < 1.0);
    assert_eq!(pairs, 59);
    assert_eq!(valid_count, 59);
}

#[test]
fn averaging_reads_noisy_slow_motion() {
    // 240 fps slow motion: each subframe is seen 4 times, strong noise. The
    // averaging (gray R averaged, last 4 P) decodes the three frames.
    let mut receiver = TmReceiver::new(&TmReceiverOptions {
        averaging: true,
        ..Default::default()
    });
    let mut new_frames = Vec::new();
    let (mut t, mut seed) = (0.0, 1000);
    let frames: Vec<Vec<u8>> = (0..3).map(|i| stream_frame(Codec::Color8, 600 + i)).collect();
    for raw in &frames {
        for grid in [
            reference_subframe(raw, Codec::Color8).unwrap(),
            payload_subframe(raw, Codec::Color8).unwrap(),
        ] {
            for _ in 0..4 {
                let o = SimulationOptions {
                    rotation_degrees: 2.0,
                    gains: [1.1, 0.9, 1.05],
                    noise: 40.0,
                    seed,
                    ..Default::default()
                };
                seed += 1;
                t += 1000.0 / 240.0;
                if let Some(tr) = receiver
                    .process(&simulate_capture(&grid, &PALETTE_TM, &o), t)
                    .frame
                    .filter(|tr| tr.is_new)
                {
                    new_frames.push(tr.bytes);
                }
            }
        }
    }
    assert_eq!(new_frames.len(), 3);
    for (b, decoded) in frames.iter().zip(&new_frames) {
        assert_eq!(&decoded[..b.len()], &b[..]);
    }
}

// ── mosaic.spec.ts ────────────────────────────────────────────────────────

fn batch(frames: &[Vec<u8>], columns: usize, module_size: usize) -> (ImageRGBA, ImageRGBA) {
    let o = RenderOptions {
        module_size,
        quiet_zone: 2,
    };
    let r: Vec<Vec<u8>> = frames
        .iter()
        .map(|t| reference_subframe(t, Codec::Color8).unwrap())
        .collect();
    let p: Vec<Vec<u8>> = frames
        .iter()
        .map(|t| payload_subframe(t, Codec::Color8).unwrap())
        .collect();
    (
        render_mosaic(&r, &PALETTE_TM, columns, &o),
        render_mosaic(&p, &PALETTE_TM, columns, &o),
    )
}

fn channel(seed: u32) -> SimulationOptions {
    SimulationOptions {
        rotation_degrees: 4.0,
        scale: 0.92,
        gains: [1.2, 0.85, 1.1],
        noise: 5.0,
        seed,
        ..Default::default()
    }
}

#[test]
fn mosaic_all_grids_found_and_decoded() {
    for (columns, module_size) in [(2usize, 8usize), (3, 7)] {
        let n = columns * columns;
        let frames: Vec<Vec<u8>> = (0..n as u32)
            .map(|i| mosaic_frame(Codec::Color8, 100 + i))
            .collect();
        let (r, p) = batch(&frames, columns, module_size);
        let (img_r, img_p) = (degrade_image(&r, &channel(1)), degrade_image(&p, &channel(2)));
        let locs_r = locate_all(&img_r, Some(TM_ALIGNMENT), 16);
        assert_eq!(locs_r.len(), n, "{columns}×{columns}");
        let mut receiver = TmMosaicReceiver::default();
        receiver.process(&img_r, &locs_r, 0.0);
        let results = receiver.process(
            &img_p,
            &locate_all(&img_p, Some(TM_ALIGNMENT), 16),
            250.0,
        );
        let frames_read: Vec<&Vec<u8>> = results
            .iter()
            .filter_map(|x| x.frame.as_ref().map(|t| &t.bytes))
            .collect();
        assert_eq!(frames_read.len(), n);
        for (t, decoded) in frames.iter().zip(frames_read) {
            assert_eq!(&decoded[..t.len()], &t[..]);
        }
    }
}

#[test]
fn mosaic_two_successive_batches() {
    let mut receiver = TmMosaicReceiver::default();
    let mut received: HashSet<Vec<u8>> = HashSet::new();
    let mut t = 0.0;
    for base in [200u32, 300] {
        let frames: Vec<Vec<u8>> = (0..4)
            .map(|i| mosaic_frame(Codec::Color8, base + i))
            .collect();
        let (r, p) = batch(&frames, 2, 8);
        for (img, g) in [(r, base), (p, base + 1)] {
            let deg = degrade_image(&img, &channel(g));
            t += 100.0;
            for res in receiver.process(&deg, &locate_all(&deg, Some(TM_ALIGNMENT), 16), t) {
                if let Some(tr) = res.frame.filter(|tr| tr.is_new) {
                    received.insert(tr.bytes[..40].to_vec());
                }
            }
        }
    }
    assert_eq!(received.len(), 8);
}

#[test]
fn mosaic_p_shows_a_single_grid() {
    let frames: Vec<Vec<u8>> = (0..4)
        .map(|i| mosaic_frame(Codec::Color8, 400 + i))
        .collect();
    let (r, p) = batch(&frames, 2, 8);
    let (img_r, img_p) = (degrade_image(&r, &channel(7)), degrade_image(&p, &channel(8)));
    let mut receiver = TmMosaicReceiver::default();
    receiver.process(
        &img_r,
        &locate_all(&img_r, Some(TM_ALIGNMENT), 16),
        0.0,
    );
    let locs_p = locate_all(&img_p, Some(TM_ALIGNMENT), 16);
    let results = receiver.process(&img_p, &locs_p[..1], 150.0);
    assert_eq!(results.iter().filter(|x| x.frame.is_some()).count(), 4);
    assert_eq!(receiver.stats.valid_count, 4);
}

#[test]
fn pipeline_single_grid_then_mosaic() {
    // TmPipeline: a single grid goes through the single receiver (fast
    // tracking between two full searches), a mosaic through the cells.
    let mut pipeline = TmPipeline::default();
    let mut t = 0.0;
    let mut new_frames = 0;
    let raw = stream_frame(Codec::Color8, 42);
    for (i, grid) in [
        reference_subframe(&raw, Codec::Color8).unwrap(),
        payload_subframe(&raw, Codec::Color8).unwrap(),
    ]
    .iter()
    .enumerate()
    {
        t += 100.0;
        let all = pipeline.process(
            &simulate_capture(grid, &PALETTE_TM, &channel(50 + i as u32)),
            t,
        );
        assert_eq!(all.len(), 1);
        new_frames += all
            .iter()
            .filter(|r| r.frame.as_ref().is_some_and(|tr| tr.is_new))
            .count();
    }
    assert_eq!(new_frames, 1);
    let frames: Vec<Vec<u8>> = (0..4)
        .map(|i| mosaic_frame(Codec::Color8, 500 + i))
        .collect();
    let (r, p) = batch(&frames, 2, 8);
    for (k, img) in [r, p].iter().enumerate() {
        t += 120.0;
        let all = pipeline.process(&degrade_image(img, &channel(60 + k as u32)), t);
        assert_eq!(all.len(), 4);
        new_frames += all
            .iter()
            .filter(|r| r.frame.as_ref().is_some_and(|tr| tr.is_new))
            .count();
    }
    assert_eq!(new_frames, 5);
    assert_eq!(pipeline.stats().valid_count, 5);
}

// ── optical.spec.ts (static codecs) ───────────────────────────────────────

fn static_frame(codec: Codec, nb: usize) -> (FrameHeader, Vec<u8>) {
    let mut rng = orp_core::Mulberry32::new(2026);
    let payload: Vec<u8> = (0..nb * SYMBOL_SIZE)
        .map(|_| (rng.next_f64() * 256.0).floor() as u8)
        .collect();
    (
        FrameHeader {
            version: FRAME_VERSION,
            codec,
            flags: 0,
            token: 0x1122_3344,
            block: 2,
            k: 50,
            symbol_count: nb as u8,
            seed: 99,
        },
        payload,
    )
}

#[test]
fn grid_v01() {
    assert_eq!(data_module_count(), 1423);
    assert_eq!(available_bits(Codec::Mono2), 1423);
    assert_eq!(available_bits(Codec::Color8), 3 * 1423);
}

#[test]
fn round_trip_ideal_capture() {
    for (codec, nb) in [(Codec::Mono2, 1), (Codec::Color4, 2), (Codec::Color8, 4)] {
        let (header, payload) = static_frame(codec, nb);
        let image = render(
            &encode_frame(&header, &payload, None).unwrap(),
            palette_for(codec),
            &RenderOptions::default(),
        );
        let d = decode_grid(&image, codec, &DecodeOptions::default()).unwrap();
        let parsed = read_frame(&d.bytes).unwrap();
        assert_eq!(parsed.header.token, 0x1122_3344);
        assert_eq!(parsed.header.block, 2);
        assert_eq!(parsed.payload, payload);
        assert!(d.mean_confidence > 0.8, "{codec:?}");
    }
}

#[test]
fn geometric_robustness_mono2() {
    let (header, payload) = static_frame(Codec::Mono2, 1);
    let grid = encode_frame(&header, &payload, None).unwrap();
    for o in [
        SimulationOptions {
            rotation_degrees: 5.0,
            ..Default::default()
        },
        SimulationOptions {
            rotation_degrees: -6.0,
            ..Default::default()
        },
        SimulationOptions {
            scale: 0.8,
            ..Default::default()
        },
        SimulationOptions {
            scale: 1.08,
            translation: [8.0, -6.0],
            ..Default::default()
        },
    ] {
        let image = simulate_capture(&grid, palette_for(Codec::Mono2), &o);
        let parsed = read_frame(
            &decode_grid(&image, Codec::Mono2, &DecodeOptions::default())
                .unwrap()
                .bytes,
        )
        .unwrap();
        assert_eq!(parsed.payload, payload, "{o:?}");
    }
}

#[test]
fn geometric_robustness_color8_calibrated() {
    let (header, payload) = static_frame(Codec::Color8, 4);
    let grid = encode_frame(&header, &payload, None).unwrap();
    let test_pattern = encode_test_pattern(Codec::Color8, TEST_PATTERN_SEED);
    let palette = palette_for(Codec::Color8);
    for o in [
        SimulationOptions {
            rotation_degrees: 4.0,
            ..Default::default()
        },
        SimulationOptions {
            scale: 0.9,
            ..Default::default()
        },
        SimulationOptions {
            rotation_degrees: -5.0,
            scale: 0.95,
            translation: [-10.0, 15.0],
            ..Default::default()
        },
    ] {
        let cal = calibrate(&simulate_capture(&test_pattern, palette, &o), Codec::Color8, None).unwrap();
        let image = simulate_capture(&grid, palette, &o);
        let d = decode_grid(
            &image,
            Codec::Color8,
            &DecodeOptions {
                palette: Some(&cal),
                confidence_threshold: None,
            },
        )
        .unwrap();
        assert_eq!(read_frame(&d.bytes).unwrap().payload, payload, "{o:?}");
    }
}

#[test]
fn moderate_noise_color8() {
    let (header, payload) = static_frame(Codec::Color8, 4);
    let image = simulate_capture(
        &encode_frame(&header, &payload, None).unwrap(),
        palette_for(Codec::Color8),
        &SimulationOptions {
            noise: 6.0,
            seed: 7,
            ..Default::default()
        },
    );
    assert_eq!(
        read_frame(
            &decode_grid(&image, Codec::Color8, &DecodeOptions::default())
                .unwrap()
                .bytes
        )
        .unwrap()
        .payload,
        payload
    );
}

#[test]
fn scale_robustness() {
    for module_size in [10, 12, 16, 24] {
        let (header, payload) = static_frame(Codec::Color8, 4);
        let image = render(
            &encode_frame(&header, &payload, None).unwrap(),
            palette_for(Codec::Color8),
            &RenderOptions {
                module_size,
                quiet_zone: 2,
            },
        );
        let parsed = read_frame(
            &decode_grid(&image, Codec::Color8, &DecodeOptions::default())
                .unwrap()
                .bytes,
        )
        .unwrap();
        assert_eq!(parsed.payload, payload, "module_size {module_size}");
    }
}

#[test]
fn calibration_recovers_hue() {
    let palette = palette_for(Codec::Color8);
    let test_pattern = encode_test_pattern(Codec::Color8, TEST_PATTERN_SEED);
    let ideal = calibrate(
        &simulate_capture(&test_pattern, palette, &SimulationOptions::default()),
        Codec::Color8,
        None,
    )
    .unwrap();
    assert_eq!(ideal.centroids.len(), 8);
    assert!(ideal.confidence > 0.75);

    let gains = SimulationOptions {
        gains: [1.25, 0.85, 1.1],
        ..Default::default()
    };
    let cal = calibrate(
        &simulate_capture(&test_pattern, palette, &gains),
        Codec::Color8,
        None,
    )
    .unwrap();
    let (header, payload) = static_frame(Codec::Color8, 4);
    let image = simulate_capture(
        &encode_frame(&header, &payload, None).unwrap(),
        palette,
        &gains,
    );
    let with = decode_grid(
        &image,
        Codec::Color8,
        &DecodeOptions {
            palette: Some(&cal),
            confidence_threshold: None,
        },
    )
    .unwrap();
    let nominal = decode_grid(&image, Codec::Color8, &DecodeOptions::default()).unwrap();
    assert_eq!(read_frame(&with.bytes).unwrap().payload, payload);
    assert!(with.mean_confidence > nominal.mean_confidence);
}

#[test]
fn eight_color_mode_validation() {
    let palette = palette_for(Codec::Color8);
    let test_pattern = encode_test_pattern(Codec::Color8, TEST_PATTERN_SEED);
    let captures = [
        simulate_capture(
            &test_pattern,
            palette,
            &SimulationOptions {
                rotation_degrees: 3.0,
                ..Default::default()
            },
        ),
        simulate_capture(
            &test_pattern,
            palette,
            &SimulationOptions {
                scale: 0.9,
                ..Default::default()
            },
        ),
        simulate_capture(
            &test_pattern,
            palette,
            &SimulationOptions {
                noise: 4.0,
                seed: 3,
                ..Default::default()
            },
        ),
    ];
    let (valid, confidences) =
        validate_mode(Codec::Color8, &captures, &[None, None, None], 0.5).unwrap();
    assert!(valid);
    assert!(confidences.iter().all(|&c| c > 0.5));
}

#[test]
fn pairing_code_color4() {
    let payload: Vec<u8> = (0..100u32).map(|i| ((i * 13) & 0xff) as u8).collect();
    let grid = encode_pairing_code(&payload).unwrap();
    let image = simulate_capture(
        &grid,
        palette_for(Codec::Color4),
        &SimulationOptions {
            rotation_degrees: 3.0,
            ..Default::default()
        },
    );
    let parsed = read_frame(
        &decode_grid(&image, Codec::Color4, &DecodeOptions::default())
            .unwrap()
            .bytes,
    )
    .unwrap();
    assert!(parsed.header.flags & 0x08 != 0);
    assert_eq!(&parsed.payload[..100], &payload[..]);
}
