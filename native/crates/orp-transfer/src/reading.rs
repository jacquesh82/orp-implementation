//! ADAPTIVE reading of a video, frame by frame (video.ts, decoderEtLire):
//! - SEARCH while no recent grid: one image every 80 ms;
//! - READING afterwards: ≈ 3 images analyzed per sender subframe, its
//!   duration measured at the R↔P toggles — no point analyzing the 8 images
//!   of a 33 ms subframe filmed at 240 fps.
//! Time is the VIDEO's (image timestamps), not the wall clock.

use orp_optics::pipeline::TmPipeline;
use orp_optics::tm_receiver::{TmReceiverOptions, TmImageResult};
use orp_optics::render::ImageRGBA;
use orp_optics::temporal::SubframeKind;

#[derive(Debug, Clone, Default)]
pub struct ReadingProgress {
    /// Position in the video (s).
    pub position: f64,
    pub seen_images: u64,
    pub analyzed_images: u64,
    pub grids: usize,
    pub valid_count: u64,
    pub pairs: u64,
    pub mixed_count: u64,
    /// Measured frame rate (fps), 0 while unknown.
    pub cadence: f64,
}

pub struct AdaptiveReader {
    pub pipeline: TmPipeline,
    /// Analyze ALL images (check, comparison with the TS replay).
    pub every_image: bool,
    /// Time (s, video time) of the first grid seen.
    pub first_grid: Option<f64>,
    prog: ReadingProgress,
    last_search: f64,
    last_grid: f64,
    last_analysis: f64,
    previous: Option<f64>,
    gaps: Vec<f64>,
    toggles: Vec<f64>,
    last_type: Option<SubframeKind>,
    last_switch: Option<f64>,
}

impl Default for AdaptiveReader {
    fn default() -> Self {
        Self::new()
    }
}

impl AdaptiveReader {
    pub fn new() -> Self {
        let options = TmReceiverOptions { averaging: true, ..TmReceiverOptions::default() };
        Self {
            pipeline: TmPipeline::new(&options),
            every_image: false,
            first_grid: None,
            prog: ReadingProgress::default(),
            last_search: f64::NEG_INFINITY,
            last_grid: f64::NEG_INFINITY,
            last_analysis: f64::NEG_INFINITY,
            previous: None,
            gaps: Vec::new(),
            toggles: Vec::new(),
            last_type: None,
            last_switch: None,
        }
    }

    pub fn progress(&self) -> ReadingProgress {
        let s = self.pipeline.stats();
        ReadingProgress { valid_count: s.valid_count, pairs: s.pairs, mixed_count: s.mixed_count, ..self.prog.clone() }
    }

    /// Should the image at time `t` (s) be analyzed? If not, do not convert it.
    pub fn should_analyze(&mut self, t: f64) -> bool {
        self.prog.position = t;
        self.prog.seen_images += 1;
        if let Some(p) = self.previous {
            if t > p && self.gaps.len() < 15 {
                self.gaps.push(t - p);
                if self.gaps.len() == 15 {
                    let mut e = self.gaps.clone();
                    e.sort_by(f64::total_cmp);
                    self.prog.cadence = 1.0 / e[7];
                }
            }
        }
        self.previous = Some(t);
        if self.every_image {
            return true;
        }
        let searching = t - self.last_grid > 0.5;
        if searching && t - self.last_search < 0.08 {
            return false;
        }
        if searching {
            self.last_search = t;
        }
        if !searching && self.toggles.len() >= 4 && self.prog.cadence > 0.0 {
            let mut b = self.toggles.clone();
            b.sort_by(f64::total_cmp);
            let subframe = b[b.len() >> 1];
            if t - self.last_analysis < subframe / 3.0 - 0.5 / self.prog.cadence {
                return false;
            }
        }
        true
    }

    /// Analyzes the image (time `t` in s); returns the results per grid.
    pub fn analyze(&mut self, t: f64, image: &ImageRGBA) -> Vec<TmImageResult> {
        self.last_analysis = t;
        let all = self.pipeline.process(image, t * 1000.0);
        self.prog.analyzed_images += 1;
        self.prog.grids = all.iter().filter(|r| r.location.is_some()).count();
        if self.prog.grids > 0 {
            self.last_grid = t;
            self.first_grid.get_or_insert(t);
        }
        if let Some(type_) = all.first().and_then(|r| r.subframe.as_ref()).map(|s| s.type_) {
            if matches!(type_, SubframeKind::R | SubframeKind::P) && Some(type_) != self.last_type {
                if let (Some(b), Some(_)) = (self.last_switch, self.last_type) {
                    if t - b < 1.0 {
                        self.toggles.push(t - b);
                        if self.toggles.len() > 9 {
                            self.toggles.remove(0);
                        }
                    }
                }
                self.last_switch = Some(t);
                self.last_type = Some(type_);
            }
        }
        all
    }
}

/// Delay (s of video, since the first grid seen) to read the init code.
/// The bench shows it in a loop during the countdown, then repeats it in
/// the stream: past this delay, the rest will not be better — no point
/// computing for minutes for nothing.
pub const CODE_TIMEOUT: f64 = 6.0;

/// Message when the code was not read in time.
pub const CODE_NOT_READ_MESSAGE: &str = "Initialization code not read in the first seconds: reading stopped. \
Likely causes: the start of the transmission was not filmed, or the subframe is too short for this screen \
(at 17 ms, an LCD screen does not settle the grey) — try 33 ms, or bring the phone closer.";

impl AdaptiveReader {
    /// True if a grid has been seen for `CODE_TIMEOUT` seconds at time `t`.
    pub fn code_timed_out(&self, t: f64) -> bool {
        self.first_grid.map(|t0| t - t0 > CODE_TIMEOUT).unwrap_or(false)
    }
}
