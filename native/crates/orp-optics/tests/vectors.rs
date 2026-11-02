//! The port against the TypeScript vectors (`native/vectors/optics/`):
//! identical grids and pixels, locations, analyses and decodings on the SAME
//! images, receiver sequences step by step.

mod common;

use common::*;
use orp_core::Codec;
use orp_optics::*;
use serde_json::Value;

#[test]
fn structure_and_mask() {
    let s = &V["structure"];
    assert_eq!(
        s["dataModuleCount"].as_u64().unwrap() as usize,
        data_module_count()
    );
    assert_eq!(
        s["tmDataModuleCount"].as_u64().unwrap() as usize,
        tm_data_modules().len()
    );
    assert_eq!(
        s["tmCapacity8"].as_u64().unwrap() as usize,
        tm_capacity(Codec::Color8).unwrap()
    );
    assert_eq!(
        s["tmCapacity4"].as_u64().unwrap() as usize,
        tm_capacity(Codec::Color4).unwrap()
    );
    let palette: Vec<Vec<u64>> = s["tmPalette"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            c.as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .collect()
        })
        .collect();
    assert_eq!(
        palette,
        PALETTE_TM
            .iter()
            .map(|c| c.iter().map(|&v| v as u64).collect::<Vec<_>>())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        s["structureC8"].as_str().unwrap(),
        hex(&structural_grid(Codec::Color8))
    );
    let ones = vec![1f32; tm_data_modules().len() * 3];
    assert_eq!(
        s["onesDecision8"].as_str().unwrap(),
        hex(&decide_tm(&ones, Codec::Color8).unwrap().bytes)
    );
    assert_eq!(
        s["onesDecision4"].as_str().unwrap(),
        hex(&decide_tm(&ones, Codec::Color4).unwrap().bytes)
    );
}

#[test]
fn tm_and_static_grids() {
    assert_eq!(
        V["frames"]["T8"].as_str().unwrap(),
        hex(&test_frame(Codec::Color8))
    );
    assert_eq!(
        V["frames"]["T4"].as_str().unwrap(),
        hex(&test_frame(Codec::Color4))
    );
    for name in ["R8", "P8", "R4", "P4"] {
        assert_eq!(
            V["grids"][name].as_str().unwrap(),
            hex(&source_grid(name)),
            "grid {name}"
        );
    }
    assert_eq!(
        V["static"]["payload"].as_str().unwrap(),
        hex(&static_payload())
    );
    assert_eq!(
        V["static"]["grid"].as_str().unwrap(),
        hex(&static_grid())
    );
    assert_eq!(
        V["static"]["testPattern"].as_str().unwrap(),
        hex(&encode_test_pattern(Codec::Color8, TEST_PATTERN_SEED))
    );
}

#[test]
fn pixel_exact_renders() {
    let r = &V["renders"];
    let t8 = test_frame(Codec::Color8);
    let pair = render_tm_pair(
        &t8,
        Codec::Color8,
        &RenderOptions {
            module_size: 6,
            quiet_zone: 2,
        },
    )
    .unwrap();
    check_image(&r["pairR6"], &pair.reference, "pair R");
    check_image(&r["pairP6"], &pair.payload, "pair P");
    check_image(
        &r["static8"],
        &render(
            &static_grid(),
            palette_for(Codec::Color8),
            &RenderOptions::default(),
        ),
        "static",
    );
    check_image(&r["mosaicR"], &mosaic_vectors(false), "mosaic R");
    check_image(&r["mosaicP"], &mosaic_vectors(true), "mosaic P");
    let three: Vec<Vec<u8>> = (0..3)
        .map(|i| payload_subframe(&stream_frame(Codec::Color8, 100 + i), Codec::Color8).unwrap())
        .collect();
    let incomplete = render_mosaic(
        &three,
        &PALETTE_TM,
        2,
        &RenderOptions {
            module_size: 3,
            quiet_zone: 1,
        },
    );
    check_image(
        &r["mosaic3Incomplete"],
        &incomplete,
        "incomplete mosaic",
    );
    for (i, t) in r["mosaicFrames"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            t.as_str().unwrap(),
            hex(&stream_frame(Codec::Color8, 100 + i as u32))
        );
    }
}

#[test]
fn pixel_exact_simulations() {
    for s in V["simulations"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        check_image(s, image(name), &format!("simulation {name}"));
    }
}

#[test]
fn raw_image_decoding() {
    let read = |v: &Value| {
        let data =
            std::fs::read(vectors_dir().join(v["file"].as_str().unwrap())).unwrap();
        let img = ImageRGBA {
            width: v["width"].as_u64().unwrap() as usize,
            height: v["height"].as_u64().unwrap() as usize,
            data,
        };
        check_image(v, &img, "raw image");
        img
    };
    let (r, p) = (read(&V["rawImages"]["R"]), read(&V["rawImages"]["P"]));
    let d = decoder_tm(&r, &p, Codec::Color8).unwrap();
    let expected = &V["decodings"]["R8-hostile+P8-hostile"];
    assert_eq!(expected["bytes"].as_str().unwrap(), hex(&d.decision.bytes));
    assert_eq!(
        expected["soft"].as_u64().unwrap(),
        fnv_f32(&d.measurement.soft) as u64
    );
}

#[test]
fn locations() {
    for (name, expected) in V["locations"].as_object().unwrap() {
        if name == "tracking-persp" {
            continue;
        }
        let img = image(name);
        let candidates = detect_markers(img, DetectionThreshold::Otsu);
        let ac = expected["candidates"].as_array().unwrap();
        assert_eq!(ac.len(), candidates.len(), "{name}: candidate count");
        for (a, c) in ac.iter().zip(&candidates) {
            nearest(f(&a["x"]), c.x, &format!("{name} candidate x"));
            nearest(f(&a["y"]), c.y, &format!("{name} candidate y"));
            nearest(f(&a["score"]), c.score, &format!("{name} candidate score"));
        }
        assert_eq!(
            expected["localCandidates"].as_u64().unwrap() as usize,
            detect_markers(img, DetectionThreshold::Local).len(),
            "{name}: candidates (local threshold)"
        );
        match (&expected["triplet"], choose_triplet(&candidates)) {
            (Value::Null, None) => {}
            (t, Some(decoded)) if !t.is_null() => {
                for i in 0..3 {
                    for j in 0..2 {
                        nearest(f(&t[i][j]), decoded[i][j], &format!("{name} triplet"));
                    }
                }
            }
            (t, decoded) => panic!("{name}: triplet expected {t}, read {decoded:?}"),
        }
        check_loc(
            &expected["affineOnly"],
            locate(img, None, None).as_ref(),
            &format!("{name} affine only"),
        );
        check_loc(
            &expected["tm"],
            locate_tm(img, None).as_ref(),
            &format!("{name} TM"),
        );
        let all = locate_all(img, Some(TM_ALIGNMENT), 16);
        let at = expected["all"].as_array().unwrap();
        assert_eq!(at.len(), all.len(), "{name}: locate_all");
        for (a, l) in at.iter().zip(&all) {
            check_loc(a, Some(l), &format!("{name} all"));
        }
    }
    let s = &V["locations"]["tracking-persp"];
    let loc_r = locate_tm(image("R8-persp"), None).unwrap();
    check_loc(
        &s["tmWithPrevious"],
        locate_tm(image("P8-persp"), Some(&loc_r)).as_ref(),
        "P with previous",
    );
    check_loc(
        &s["trackLocation"],
        track_location(
            image("P8-persp"),
            &loc_r,
            Some(TM_ALIGNMENT),
            TRACKING_STILL,
        )
        .as_ref(),
        "tracking P",
    );
    check_loc(
        &s["trackStill"],
        track_location(
            image("R8-persp"),
            &loc_r,
            Some(TM_ALIGNMENT),
            TRACKING_STILL,
        )
        .as_ref(),
        "still tracking",
    );
}

#[test]
fn pair_analyses_and_decodings() {
    let pairs = [
        ("R8-hostile", "P8-hostile"),
        ("R4-hostile", "P4-hostile"),
        ("R8-persp", "P8-persp"),
        ("R8-matrix", "P8-matrix"),
        ("R4-rot233", "P4-rot233"),
        ("R8-hard", "P8-hard"),
    ];
    for (name_r, name_p) in pairs {
        let (r, p) = (image(name_r), image(name_p));
        let loc_r = locate_tm(r, None).unwrap();
        let loc_p = locate_tm(p, Some(&loc_r)).unwrap_or(loc_r);
        let s_r = analyze_subframe(r, &loc_r);
        let s_p = analyze_subframe(p, &loc_p);
        check_sub(&V["analyses"][name_r], &s_r, name_r);
        check_sub(&V["analyses"][name_p], &s_p, name_p);

        let key = format!("{name_r}+{name_p}");
        let a = &V["decodings"][key.as_str()];
        let c = codec(&a["codec"]);
        let d = decoder_tm(r, p, c).unwrap();
        assert_eq!(
            a["bytes"].as_str().unwrap(),
            hex(&d.decision.bytes),
            "{key}: bytes"
        );
        nearest(
            f(&a["meanConfidence"]),
            d.decision.mean_confidence,
            &format!("{key} confiance"),
        );
        nearest(
            f(&a["uncertainShare"]),
            d.decision.uncertain_fraction,
            &format!("{key} incertains"),
        );
        for i in 0..3 {
            nearest(
                f(&a["gains"][i]),
                d.measurement.gains[i],
                &format!("{key} gains"),
            );
        }
        nearest(
            f(&a["crosstalk"]),
            d.measurement.crosstalk,
            &format!("{key} diaphonie"),
        );
        nearest(f(&a["residual"]), d.measurement.residual, &format!("{key} residu"));
        assert_eq!(
            a["fullMatrix"].as_bool().unwrap(),
            d.measurement.full_matrix,
            "{key}: full matrix"
        );
        assert_eq!(
            a["soft"].as_u64().unwrap(),
            fnv_f32(&d.measurement.soft) as u64,
            "{key}: soft"
        );
        assert_eq!(
            a["softMeasured"].as_u64().unwrap(),
            fnv_f32(&measure_tm_pair(&s_r, &s_p).soft) as u64,
            "{key}: soft (measurement)"
        );
        let other = if c == Codec::Color8 {
            Codec::Color4
        } else {
            Codec::Color8
        };
        assert_eq!(
            a["otherMode"].as_str().unwrap(),
            hex(&decide_tm(&d.measurement.soft, other).unwrap().bytes),
            "{key}: other mode"
        );
    }
    // MIXED subframe: top half R, bottom half P.
    let (r, p) = (image("R8-hostile"), image("P8-hostile"));
    let mut mixed = r.clone();
    let cut = (r.height / 2) * r.width * 4;
    mixed.data[cut..].copy_from_slice(&p.data[cut..]);
    let loc = locate_tm(r, None).unwrap();
    check_sub(
        &V["analyses"]["mixed-hostile"],
        &analyze_subframe(&mixed, &loc),
        "mixed",
    );
}

/// Replays a sequence of (described) images on a single receiver.
fn replay(name: &str, receiver: &mut TmReceiver, locate_first: bool) {
    let seq = &V["sequences"][name];
    for (i, e) in seq["steps"].as_array().unwrap().iter().enumerate() {
        let context = format!("{name} step {i}");
        let raw = from_hex(e["frame"].as_str().unwrap());
        let codec = Codec::from_u8(raw[4]).unwrap();
        let grid = if e["kind"] == "R" {
            reference_subframe(&raw, codec)
        } else {
            payload_subframe(&raw, codec)
        }
        .unwrap();
        let img = simulate_capture(&grid, &PALETTE_TM, &simulation_options(&e["options"]));
        check_image(&e["image"], &img, &context);
        let t = f(&e["t"]);
        let r = if locate_first {
            let locs = locate_all(&img, Some(TM_ALIGNMENT), 16);
            assert_eq!(
                e["locationCount"].as_u64().unwrap() as usize,
                locs.len(),
                "{context}: locate_all"
            );
            match locs.first() {
                Some(l) => receiver.process_located(&img, l, t, true),
                None => receiver.process(&img, t),
            }
        } else {
            receiver.process(&img, t)
        };
        check_result(&e["result"], &r, &context);
    }
    check_stats(&seq["stats"], &receiver.stats, name);
}

#[test]
fn receiver_tm8_tm4_stream() {
    replay("stream8", &mut TmReceiver::default(), false);
    replay("stream4", &mut TmReceiver::default(), false);
}

#[test]
fn receiver_harsh_conditions() {
    replay("hard", &mut TmReceiver::default(), true);
}

#[test]
fn averaging_receiver() {
    replay(
        "averaging",
        &mut TmReceiver::new(&TmReceiverOptions {
            averaging: true,
            ..Default::default()
        }),
        false,
    );
}

#[test]
fn mosaic_receiver() {
    let m = &V["sequences"]["mosaic"];
    let (img_r, img_p) = (image("mosR-channel"), image("mosP-channel"));
    let locs_r = locate_all(img_r, Some(TM_ALIGNMENT), 16);
    let locs_p = locate_all(img_p, Some(TM_ALIGNMENT), 16);
    for (expected, read_items, name) in [(&m["locsR"], &locs_r, "R"), (&m["locsP"], &locs_p, "P")] {
        let a = expected.as_array().unwrap();
        assert_eq!(a.len(), read_items.len(), "mosaic {name}: grids");
        for (k, (x, l)) in a.iter().zip(read_items.iter()).enumerate() {
            check_loc(x, Some(l), &format!("mosaic {name} grid {k}"));
        }
    }
    let check = |expected_list: &Value, read_items: &[TmImageResult], context: &str| {
        let a = expected_list.as_array().unwrap();
        assert_eq!(a.len(), read_items.len(), "{context}: results");
        for (k, (x, r)) in a.iter().zip(read_items).enumerate() {
            check_result(x, r, &format!("{context} [{k}]"));
        }
    };
    let mut complete = TmMosaicReceiver::default();
    check(
        &m["complete"]["r"],
        &complete.process(img_r, &locs_r, 0.0),
        "complete R",
    );
    check(
        &m["complete"]["p"],
        &complete.process(img_p, &locs_p, 250.0),
        "complete P",
    );
    check_stats(&m["complete"]["stats"], &complete.stats, "complete");
    assert_eq!(
        m["complete"]["cells"].as_u64().unwrap() as usize,
        complete.cell_count()
    );

    let mut partial = TmMosaicReceiver::default();
    check(
        &m["partial"]["r"],
        &partial.process(img_r, &locs_r, 0.0),
        "partial R",
    );
    check(
        &m["partial"]["p"],
        &partial.process(img_p, &locs_p[..1], 150.0),
        "partial P",
    );
    check_stats(&m["partial"]["stats"], &partial.stats, "partial");
    assert_eq!(
        m["partial"]["cells"].as_u64().unwrap() as usize,
        partial.cell_count()
    );
}

#[test]
fn tm_pipeline() {
    let c = &V["sequences"]["pipeline"];
    let mut pipeline = TmPipeline::default();
    for (i, e) in c["steps"].as_array().unwrap().iter().enumerate() {
        let context = format!("pipeline step {i}");
        let options = simulation_options(&e["options"]);
        let r = e["subframe"] == "R";
        let img = if e["kind"] == "single" {
            let raw = from_hex(e["frame"].as_str().unwrap());
            let g = if r {
                reference_subframe(&raw, Codec::Color8)
            } else {
                payload_subframe(&raw, Codec::Color8)
            }
            .unwrap();
            simulate_capture(&g, &PALETTE_TM, &options)
        } else {
            let grids: Vec<Vec<u8>> = e["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| {
                    let b = from_hex(t.as_str().unwrap());
                    if r {
                        reference_subframe(&b, Codec::Color8)
                    } else {
                        payload_subframe(&b, Codec::Color8)
                    }
                    .unwrap()
                })
                .collect();
            degrade_image(
                &render_mosaic(
                    &grids,
                    &PALETTE_TM,
                    2,
                    &RenderOptions {
                        module_size: 8,
                        quiet_zone: 2,
                    },
                ),
                &options,
            )
        };
        check_image(&e["image"], &img, &context);
        let all = pipeline.process(&img, f(&e["t"]));
        let a = e["results"].as_array().unwrap();
        assert_eq!(a.len(), all.len(), "{context}: results");
        for (k, (x, res)) in a.iter().zip(&all).enumerate() {
            check_result(x, res, &format!("{context} [{k}]"));
        }
        assert_eq!(
            e["tally"]["completed"].as_u64().unwrap(),
            pipeline.tracking.count.completes,
            "{context}: full searches"
        );
        assert_eq!(
            e["tally"]["fast"].as_u64().unwrap(),
            pipeline.tracking.count.fast,
            "{context}: fast trackings"
        );
    }
    let s = pipeline.stats();
    for (name, val) in [
        ("valid", s.valid_count),
        ("pairs", s.pairs),
        ("mixed", s.mixed_count),
        ("images", s.images),
    ] {
        assert_eq!(
            c["stats"][name].as_u64().unwrap(),
            val,
            "pipeline: stats.{name}"
        );
    }
}

#[test]
fn static_codecs_and_calibration() {
    let a = &V["staticDecoding"];
    let img = image("static-C8");
    let d = decode_grid(img, Codec::Color8, &DecodeOptions::default()).unwrap();
    assert_eq!(a["nominal"]["bytes"].as_str().unwrap(), hex(&d.bytes));
    nearest_lab(
        f(&a["nominal"]["meanConfidence"]),
        d.mean_confidence,
        "nominal confidence",
    );
    nearest_lab(
        f(&a["nominal"]["uncertainShare"]),
        d.uncertain_fraction,
        "nominal uncertain fraction",
    );
    let cal = calibrate(image("test-pattern-C8"), Codec::Color8, None).unwrap();
    nearest_lab(
        f(&a["calibration"]["confidence"]),
        cal.confidence,
        "calibration confidence",
    );
    for (i, c) in a["calibration"]["centroids"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        nearest_lab(f(&c["l"]), cal.centroids[i].l, "centroid l");
        nearest_lab(f(&c["a"]), cal.centroids[i].a, "centroid a");
        nearest_lab(f(&c["b"]), cal.centroids[i].b, "centroid b");
    }
    let dc = decode_grid(
        img,
        Codec::Color8,
        &DecodeOptions {
            palette: Some(&cal),
            confidence_threshold: None,
        },
    )
    .unwrap();
    assert_eq!(a["calibrated"]["bytes"].as_str().unwrap(), hex(&dc.bytes));
    nearest_lab(
        f(&a["calibrated"]["meanConfidence"]),
        dc.mean_confidence,
        "calibrated confidence",
    );
}
