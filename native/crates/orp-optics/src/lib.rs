//! ORP optical layer — Rust port of `packages/optical` (TypeScript), with the
//! same behavior to the pixel and to the byte: rendering of grids and of TM4/TM8
//! subframes, capture simulation, location (markers, homography, tracking),
//! subframe analysis, decision, receivers (single, averaging, mosaic) and the
//! reading pipeline `TmPipeline` (packages/browser/src/tm.ts).
//!
//! Checked against the vectors of `native/vectors/optics/`, produced by the
//! TypeScript (`native/vectors/generate-optics.ts`).

// Indexed loops follow the TS line by line (same order of floating-point
// operations, hence the same bits): they are kept as they are.
#![allow(clippy::needless_range_loop)]

pub mod calibration;
pub mod pipeline;
pub mod cielab;
pub mod decoder;
pub mod encoder;
pub mod grid;
pub mod js;
pub mod location;
pub mod palettes;
pub mod tm_receiver;
pub mod render;
pub mod simulation;
pub mod temporal;

pub use calibration::{calibrate, validate_mode};
pub use pipeline::{TmPipeline, PipelineStats};
pub use cielab::{classifier, distance_lab, rgb_to_lab, Classification, Lab};
pub use decoder::{
    affine_from_triplet, apply_affine, choose_triplet, choose_triplets, decode_with_affine, decode_grid,
    detect_markers, sample, luminance, otsu_threshold, Affine, MarkerCandidate,
    DecodeOptions, CalibratedPalette, DecodeResult, DetectionThreshold, Triplet,
};
pub use encoder::{
    write_bytes_to_grid, encode_pairing_code, encode_test_pattern, encode_frame,
    encode_raw_frame, frame_for_codec, Grid, TEST_PATTERN_SEED,
};
pub use grid::{
    available_bits, structural_grid, data_modules, data_module_count, role_of,
    ModuleRole, MARKERS, GRID_SIZE, MARKER_SIZE,
};
pub use location::{
    apply_h, homography_from_4, homography_from_affine, locate, locate_all,
    track_location, Homography, Location, GridTracker, TRACKING_STILL,
};
pub use palettes::{bits_per_module, palette_for, RgbColor, WHITE, BLACK};
pub use tm_receiver::{
    framing_advice, RetainedGeometry, TmReceiverOptions, TmMosaicReceiver, TmReceiver,
    TmImageResult, TmReceiverStats, TmReceivedFrame,
};
pub use render::{render, render_mosaic, ImageRGBA, RenderOptions};
pub use simulation::{degrade_image, simulate_capture, SimulationOptions};
pub use temporal::{
    analyze_subframe, bits_tm, tm_capacity, in_tm_alignment, decide_tm, decoder_tm,
    subframe_gap, index_direction, locate_tm, measure_tm_pair, tm_test_pattern,
    tm_data_modules, average_subframes, tm_name, render_tm_pair, payload_subframe,
    reference_subframe, DecisionTM, TmMeasurement, RenderedPair, TmPhotometry, TmResult,
    TmSubframe, SubframeKind, TM_ALIGNMENT, AMPLITUDE_TM, PALETTE_TM, TM_UNCERTAIN_THRESHOLD,
};

/// Errors of the optical layer (the TS throws `Error`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpticsError {
    /// Finder markers (or grid) not found.
    NotFound(&'static str),
    /// Parameter out of range (codec without a TM representation, capacity exceeded).
    Invalid(String),
    /// Protocol error (frame construction).
    Orp(orp_core::OrpError),
}

impl std::fmt::Display for OpticsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpticsError::NotFound(m) => write!(f, "{m}"),
            OpticsError::Invalid(m) => write!(f, "{m}"),
            OpticsError::Orp(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for OpticsError {}

impl From<orp_core::OrpError> for OpticsError {
    fn from(e: orp_core::OrpError) -> Self {
        OpticsError::Orp(e)
    }
}
