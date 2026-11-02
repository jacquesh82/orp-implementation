//! Test helpers: vectors, digests, simulation options.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use orp_core::{build_frame, Codec, FrameHeader, Mulberry32, SYMBOL_SIZE, FRAME_VERSION};
use orp_optics::*;
use serde_json::Value;

pub fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/optics")
}

pub static V: LazyLock<Value> = LazyLock::new(|| {
    let text = std::fs::read_to_string(vectors_dir().join("optics.json"))
        .expect("vectors missing: run native/vectors/generate-optics.ts");
    serde_json::from_str(&text).unwrap()
});

pub fn hex(o: &[u8]) -> String {
    o.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// 32-bit FNV-1a — same digest as the generator.
pub fn fnv(o: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in o {
        h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    }
    h
}

pub fn fnv_f32(v: &[f32]) -> u32 {
    let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    fnv(&bytes)
}

pub fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("number expected: {v}"))
}

/// BIT-EXACT equality of floats: the port performs the same IEEE operations
/// in the same order (and V8's `Math.hypot` identically). The JSON files are
/// read back losslessly (`float_roundtrip`).
pub fn nearest(expected: f64, decoded: f64, context: &str) {
    assert!(
        expected.to_bits() == decoded.to_bits() || expected == decoded,
        "{context}: expected {expected:e}, read {decoded:e}"
    );
}

/// Values that go through CIELAB (`Math.pow`, `Math.cbrt`): the libms of V8
/// (fdlibm) and of Rust sometimes differ in the last bit — tight tolerance.
pub fn nearest_lab(expected: f64, decoded: f64, context: &str) {
    let tol = 1e-12 * expected.abs().max(1.0);
    assert!(
        (expected - decoded).abs() <= tol,
        "{context}: expected {expected:e}, read {decoded:e}"
    );
}

pub fn codec(v: &Value) -> Codec {
    Codec::from_u8(v.as_u64().unwrap() as u8).unwrap()
}

pub fn check_image(expected: &Value, img: &ImageRGBA, context: &str) {
    assert_eq!(
        img.width as u64,
        expected["width"].as_u64().unwrap(),
        "{context}: width"
    );
    assert_eq!(
        img.height as u64,
        expected["height"].as_u64().unwrap(),
        "{context}: height"
    );
    assert_eq!(
        fnv(&img.data) as u64,
        expected["fnv"].as_u64().unwrap(),
        "{context}: pixels"
    );
}

pub fn simulation_options(v: &Value) -> SimulationOptions {
    let mut o = SimulationOptions::default();
    let tab = |x: &Value| -> Vec<f64> { x.as_array().unwrap().iter().map(f).collect() };
    if let Some(x) = v.get("scale") {
        o.scale = f(x);
    }
    if let Some(x) = v.get("rotationDegrees") {
        o.rotation_degrees = f(x);
    }
    if let Some(x) = v.get("translation") {
        let t = tab(x);
        o.translation = [t[0], t[1]];
    }
    if let Some(x) = v.get("gains") {
        let t = tab(x);
        o.gains = [t[0], t[1], t[2]];
    }
    if let Some(x) = v.get("haze") {
        let t = tab(x);
        o.veil = [t[0], t[1], t[2]];
    }
    if let Some(x) = v.get("perspective") {
        let t = tab(x);
        o.perspective = [t[0], t[1]];
    }
    if let Some(x) = v.get("matrix") {
        let m: Vec<Vec<f64>> = x.as_array().unwrap().iter().map(tab).collect();
        o.matrix = Some(std::array::from_fn(|i| std::array::from_fn(|j| m[i][j])));
    }
    if let Some(x) = v.get("blur") {
        o.blur = x.as_u64().unwrap() as usize;
    }
    if let Some(x) = v.get("noise") {
        o.noise = f(x);
    }
    if let Some(x) = v.get("seed") {
        o.seed = x.as_u64().unwrap() as u32;
    }
    if let Some(x) = v.get("moduleSize") {
        o.module_size = x.as_u64().unwrap() as usize;
    }
    o
}

// ── Test frames (same as the TS specs) ────────────────────────────────────

pub fn frame(
    codec: Codec,
    seed: u32,
    token: u32,
    block: u32,
    k: u16,
    header_seed: u32,
) -> Vec<u8> {
    let nb = if codec == Codec::Color8 { 4 } else { 2 };
    let mut rng = Mulberry32::new(seed);
    let payload: Vec<u8> = (0..nb * SYMBOL_SIZE)
        .map(|_| (rng.next_f64() * 256.0).floor() as u8)
        .collect();
    let header = FrameHeader {
        version: FRAME_VERSION,
        codec,
        flags: 0,
        token,
        block,
        k,
        symbol_count: nb as u8,
        seed: header_seed,
    };
    build_frame(&header, &payload, None).unwrap()
}

/// `testFrame` from temporal.spec.ts.
pub fn test_frame(codec: Codec) -> Vec<u8> {
    frame(codec, 2026 + codec as u32, 0x544d38, 1, 4, 7)
}

/// Frame from tm-receiver.spec.ts.
pub fn stream_frame(codec: Codec, seed: u32) -> Vec<u8> {
    frame(codec, seed, 7, 0, 8, seed)
}

/// Frame from mosaic.spec.ts.
pub fn mosaic_frame(codec: Codec, seed: u32) -> Vec<u8> {
    frame(codec, seed, 9, 0, 40, seed)
}

// ── Sources and degraded images of the vectors ────────────────────────────

pub fn source_grid(source: &str) -> Vec<u8> {
    let (t8, t4) = (test_frame(Codec::Color8), test_frame(Codec::Color4));
    match source {
        "R8" => reference_subframe(&t8, Codec::Color8).unwrap(),
        "P8" => payload_subframe(&t8, Codec::Color8).unwrap(),
        "R4" => reference_subframe(&t4, Codec::Color4).unwrap(),
        "P4" => payload_subframe(&t4, Codec::Color4).unwrap(),
        "static" => static_grid(),
        "test-pattern" => encode_test_pattern(Codec::Color8, TEST_PATTERN_SEED),
        other => panic!("unknown source {other}"),
    }
}

pub fn static_payload() -> Vec<u8> {
    let mut rng = Mulberry32::new(2026);
    (0..4 * SYMBOL_SIZE)
        .map(|_| (rng.next_f64() * 256.0).floor() as u8)
        .collect()
}

pub fn static_grid() -> Vec<u8> {
    let header = FrameHeader {
        version: FRAME_VERSION,
        codec: Codec::Color8,
        flags: 0,
        token: 0x1122_3344,
        block: 2,
        k: 50,
        symbol_count: 4,
        seed: 99,
    };
    encode_frame(&header, &static_payload(), None).unwrap()
}

pub fn mosaic_vectors(payload: bool) -> ImageRGBA {
    let grids: Vec<Vec<u8>> = (0..4)
        .map(|i| {
            let t = stream_frame(Codec::Color8, 100 + i);
            if payload {
                payload_subframe(&t, Codec::Color8).unwrap()
            } else {
                reference_subframe(&t, Codec::Color8).unwrap()
            }
        })
        .collect();
    render_mosaic(
        &grids,
        &PALETTE_TM,
        2,
        &RenderOptions {
            module_size: 8,
            quiet_zone: 2,
        },
    )
}

pub fn produce(source: &str, options: &SimulationOptions) -> ImageRGBA {
    match source {
        "static" | "test-pattern" => {
            simulate_capture(&source_grid(source), palette_for(Codec::Color8), options)
        }
        "mosaicR" => degrade_image(&mosaic_vectors(false), options),
        "mosaicP" => degrade_image(&mosaic_vectors(true), options),
        _ => simulate_capture(&source_grid(source), &PALETTE_TM, options),
    }
}

/// All the degraded images of the vectors, regenerated by the port.
pub static IMAGES: LazyLock<HashMap<String, ImageRGBA>> = LazyLock::new(|| {
    V["simulations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                produce(
                    s["source"].as_str().unwrap(),
                    &simulation_options(&s["options"]),
                ),
            )
        })
        .collect()
});

pub fn image(name: &str) -> &'static ImageRGBA {
    &IMAGES[name]
}

// ── Comparisons ───────────────────────────────────────────────────────────

pub fn check_loc(expected: &Value, decoded: Option<&Location>, context: &str) {
    if expected.is_null() {
        assert!(decoded.is_none(), "{context}: unexpected location");
        return;
    }
    let l = decoded.unwrap_or_else(|| panic!("{context}: missing location"));
    for (i, v) in expected["h"].as_array().unwrap().iter().enumerate() {
        nearest(f(v), l.h[i], &format!("{context} h[{i}]"));
    }
    let a = &expected["affine"];
    for (name, val) in [
        ("a", l.affine.a),
        ("b", l.affine.b),
        ("c", l.affine.c),
        ("d", l.affine.d),
        ("e", l.affine.e),
        ("f", l.affine.f),
    ] {
        nearest(f(&a[name]), val, &format!("{context} affine.{name}"));
    }
    for i in 0..3 {
        for j in 0..2 {
            nearest(
                f(&expected["finders"][i][j]),
                l.markers[i][j],
                &format!("{context} finders[{i}][{j}]"),
            );
        }
    }
    match (&expected["alignment"], l.alignment) {
        (Value::Null, None) => {}
        (v, Some(al)) if !v.is_null() => {
            nearest(f(&v[0]), al[0], &format!("{context} alignment x"));
            nearest(f(&v[1]), al[1], &format!("{context} alignment y"));
        }
        (v, al) => panic!("{context}: alignment expected {v}, read {al:?}"),
    }
    nearest(
        f(&expected["perspectiveSkew"]),
        l.perspective_gap,
        &format!("{context} perspectiveSkew"),
    );
    nearest(
        f(&expected["pxPerModule"]),
        l.px_per_module,
        &format!("{context} pxPerModule"),
    );
    nearest(f(&expected["threshold"]), l.threshold, &format!("{context} threshold"));
}

pub fn type_name(t: SubframeKind) -> &'static str {
    match t {
        SubframeKind::R => "R",
        SubframeKind::P => "P",
        SubframeKind::Mixed => "mixed",
    }
}

pub fn check_sub(expected: &Value, s: &TmSubframe, context: &str) {
    assert_eq!(
        expected["type"].as_str().unwrap(),
        type_name(s.type_),
        "{context}: type"
    );
    nearest(
        f(&expected["activity"]),
        s.activity,
        &format!("{context} activity"),
    );
    nearest(
        f(&expected["coloredShare"]),
        s.colored_fraction,
        &format!("{context} coloredShare"),
    );
    nearest(
        f(&expected["saturation"]),
        s.saturation,
        &format!("{context} saturation"),
    );
    for c in 0..3 {
        nearest(
            f(&expected["photometry"]["black"][c]),
            s.photometry.black[c],
            &format!("{context} black[{c}]"),
        );
        nearest(
            f(&expected["photometry"]["white"][c]),
            s.photometry.white[c],
            &format!("{context} white[{c}]"),
        );
    }
    let pilots: Vec<f32> = expected["pilots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| f(v) as f32)
        .collect();
    assert_eq!(pilots, s.pilots, "{context}: pilots (bit-exact f32)");
    assert_eq!(
        expected["data"].as_u64().unwrap(),
        fnv_f32(&s.data) as u64,
        "{context}: data (bit-exact f32)"
    );
    check_loc(
        &expected["location"],
        Some(&s.location),
        &format!("{context} location"),
    );
}

pub fn check_result(expected: &Value, r: &TmImageResult, context: &str) {
    check_loc(&expected["location"], r.location.as_ref(), context);
    match (&expected["type"], &r.subframe) {
        (Value::Null, None) => {}
        (Value::String(t), Some(s)) => {
            assert_eq!(t, type_name(s.type_), "{context}: type");
            nearest(
                f(&expected["activity"]),
                s.activity,
                &format!("{context} activity"),
            );
        }
        (t, s) => panic!(
            "{context}: type expected {t}, read {:?}",
            s.as_ref().map(|s| s.type_)
        ),
    }
    assert_eq!(
        expected["advice"].as_str().unwrap(),
        r.advice,
        "{context}: advice"
    );
    assert_eq!(
        expected["invalidPair"].as_bool().unwrap(),
        r.invalid_pair,
        "{context}: invalidPair"
    );
    match (&expected["frame"], &r.frame) {
        (Value::Null, None) => {}
        (t, Some(decoded)) if !t.is_null() => {
            assert_eq!(
                t["bytes"].as_str().unwrap(),
                hex(&decoded.bytes),
                "{context}: bytes"
            );
            assert_eq!(codec(&t["codec"]), decoded.codec, "{context}: codec");
            assert_eq!(
                t["isNew"].as_bool().unwrap(),
                decoded.is_new,
                "{context}: isNew"
            );
            nearest(
                f(&t["confidence"]),
                decoded.confidence,
                &format!("{context} confidence"),
            );
            assert_eq!(
                t["soft"].as_u64().unwrap(),
                fnv_f32(&decoded.measurement.soft) as u64,
                "{context}: soft"
            );
        }
        (t, decoded) => panic!(
            "{context}: frame expected {}, read {}",
            !t.is_null(),
            decoded.is_some()
        ),
    }
}

pub fn check_stats(expected: &Value, s: &TmReceiverStats, context: &str) {
    for (name, val) in [
        ("images", s.images),
        ("located", s.located),
        ("mixedCount", s.mixed_count),
        ("pairs", s.pairs),
        ("validCount", s.valid_count),
    ] {
        assert_eq!(
            expected[name].as_u64().unwrap(),
            val,
            "{context}: stats.{name}"
        );
    }
}
