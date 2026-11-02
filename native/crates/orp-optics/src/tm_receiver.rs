//! "Stream" TM receiver — pure: it is fed each camera image, it locates,
//! classifies (R / P / mixed), forms a pair at each R↔P switch, decides in
//! TM8 then in TM4 and only returns a frame if Reed-Solomon + CRC validate it.
//! An R subframe (gray) is the same for all frames: it pairs with any recent
//! P.

use std::sync::Arc;

use orp_core::{crc32, read_frame, Codec};

use crate::js;
use crate::location::Location;
use crate::render::ImageRGBA;
use crate::temporal::{
    analyze_subframe, decide_tm, subframe_gap, locate_tm, measure_tm_pair,
    average_subframes, TmMeasurement, TmSubframe, SubframeKind,
};

#[derive(Debug, Clone, PartialEq)]
pub struct TmReceivedFrame {
    /// Decided bytes (complete frame, padding included).
    pub bytes: Vec<u8>,
    /// Recognized mode: COLOR_8 (TM8) or COLOR_4 (TM4).
    pub codec: Codec,
    /// False if it is the same frame as the previous one returned.
    pub is_new: bool,
    pub confidence: f64,
    pub measurement: TmMeasurement,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmImageResult {
    pub location: Option<Location>,
    pub subframe: Option<Arc<TmSubframe>>,
    /// Framing advice for the user ("" if all is well).
    pub advice: &'static str,
    /// Present when a pair has just produced a valid frame.
    pub frame: Option<TmReceivedFrame>,
    /// True when a pair was formed but yielded no valid frame.
    pub invalid_pair: bool,
}

impl TmImageResult {
    fn empty() -> Self {
        Self {
            location: None,
            subframe: None,
            advice: framing_advice(None, None, 0.0),
            frame: None,
            invalid_pair: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TmReceiverStats {
    pub images: u64,
    pub located: u64,
    pub mixed_count: u64,
    pub pairs: u64,
    pub valid_count: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmReceiverOptions {
    /// Modes tried, in order (default: TM8 then TM4).
    pub codecs: Vec<Codec>,
    /// Maximum age (ms) of a subframe to be paired (default 1200).
    pub validity_duration: f64,
    /// AVERAGING (high frame rate video): the R reference is the mean of the
    /// grayest R of the last second; each P is decoded on the mean of the
    /// last 4 P with the same content.
    pub averaging: bool,
}

impl Default for TmReceiverOptions {
    fn default() -> Self {
        Self {
            codecs: vec![Codec::Color8, Codec::Color4],
            validity_duration: 1200.0,
            averaging: false,
        }
    }
}

/// Readable framing advice, from the location and the saturation.
pub fn framing_advice(
    loc: Option<&Location>,
    saturation: Option<f64>,
    mixed_fraction: f64,
) -> &'static str {
    let Some(loc) = loc else {
        return "Aim at the screen: keep the three large corner squares in the frame.";
    };
    if loc.px_per_module < 6.0 {
        return "Too far: move closer to the screen.";
    }
    if loc.alignment.is_none() {
        return "Frame the whole grid, including the bottom-right corner.";
    }
    if loc.perspective_gap > 7.0 {
        return "Hold the phone more parallel to the screen.";
    }
    if saturation.is_some_and(|s| s > 0.03) {
        return "Image saturated: lower the brightness of the sender screen.";
    }
    if mixed_fraction > 0.4 {
        return "Many transition images: lengthen the subframe duration.";
    }
    ""
}

/// Largest displacement of the three markers between two locations, in modules.
fn marker_spread(a: &Location, b: &Location) -> f64 {
    let mut max = 0f64;
    for i in 0..3 {
        max = max.max(js::hypot(
            a.markers[i][0] - b.markers[i][0],
            a.markers[i][1] - b.markers[i][1],
        ));
    }
    max / b.px_per_module
}

/// Below this (modules), the markers have not moved: detection noise only.
const STILL: f64 = 0.08;
/// Beyond this (modules), a jump must be confirmed by the next image.
const JUMP: f64 = 3.0;
/// Averaging: maximum age (ms) of the last clean R used as the reference.
const MEAN_REFERENCE_DURATION: f64 = 15000.0;

#[derive(Debug, Clone)]
struct Retained {
    loc: Location,
    t: f64,
    from_r: bool,
    jump: Option<Location>,
}

/// RETAINED geometry of a grid: as long as the markers do not move, the same
/// homography serves all images. A small displacement is followed right
/// away; a jump of more than JUMP modules is only believed if the next image
/// confirms it.
#[derive(Debug, Clone, Default)]
pub struct RetainedGeometry {
    retained: Option<Retained>,
}

impl RetainedGeometry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Geometry to use for the image measured at time `t`.
    pub fn retain(&mut self, measured: &Location, t: f64) -> Location {
        let g = match self.retained.as_mut() {
            Some(g) if t - g.t < 1000.0 => g,
            _ => {
                self.retained = Some(Retained {
                    loc: *measured,
                    t,
                    from_r: false,
                    jump: None,
                });
                return *measured;
            }
        };
        let gap = marker_spread(measured, &g.loc);
        if gap < STILL {
            g.t = t;
            g.jump = None;
            if g.loc.alignment.is_none() && measured.alignment.is_some() {
                g.loc = *measured;
                g.from_r = false;
            }
            return g.loc;
        }
        if gap > JUMP
            && !g
                .jump
                .as_ref()
                .is_some_and(|s| marker_spread(measured, s) < STILL)
        {
            g.jump = Some(*measured);
            return g.loc;
        }
        self.retained = Some(Retained {
            loc: *measured,
            t,
            from_r: false,
            jump: None,
        });
        *measured
    }

    /// The image came from a gray subframe: if it is at the same place, its
    /// measurement replaces (once) the retained geometry.
    pub fn refine_from_r(&mut self, measured: &Location) {
        if let Some(g) = self.retained.as_mut() {
            if !g.from_r
                && measured.alignment.is_some()
                && marker_spread(measured, &g.loc) < STILL
            {
                g.loc = *measured;
                g.from_r = true;
            }
        }
    }

    pub fn forget(&mut self) {
        self.retained = None;
    }
}

#[derive(Debug, Clone)]
struct Dated {
    sub: Arc<TmSubframe>,
    t: f64,
}

#[derive(Debug, Clone)]
pub struct TmReceiver {
    pub stats: TmReceiverStats,
    codecs: Vec<Codec>,
    validity_duration: f64,
    previous: Option<(Location, f64)>,
    geometry: RetainedGeometry,
    averaging: bool,
    /// Averaging: recent R, their mean (recomputed at each R), P of the current content.
    rs: Vec<Dated>,
    r_mean: Option<TmSubframe>,
    next_p: Vec<Arc<TmSubframe>>,
    /// Last saturation measured per kind (R, P): (value, t).
    saturation: [Option<(f64, f64)>; 2],
    /// Last subframe per kind (R, P).
    last: [Option<Dated>; 2],
    last_type: Option<SubframeKind>,
    last_digest: Option<u32>,
}

fn rank(t: SubframeKind) -> usize {
    match t {
        SubframeKind::R => 0,
        _ => 1,
    }
}

impl Default for TmReceiver {
    fn default() -> Self {
        Self::new(&TmReceiverOptions::default())
    }
}

impl TmReceiver {
    pub fn new(options: &TmReceiverOptions) -> Self {
        Self {
            stats: TmReceiverStats::default(),
            codecs: options.codecs.clone(),
            validity_duration: options.validity_duration,
            previous: None,
            geometry: RetainedGeometry::new(),
            averaging: options.averaging,
            rs: Vec::new(),
            r_mean: None,
            next_p: Vec::new(),
            saturation: [None, None],
            last: [None, None],
            last_type: None,
            last_digest: None,
        }
    }

    /// Forgets the pairing state (sender change, resume).
    pub fn reset(&mut self) {
        self.previous = None;
        self.geometry.forget();
        self.rs.clear();
        self.r_mean = None;
        self.next_p.clear();
        self.saturation = [None, None];
        self.last = [None, None];
        self.last_type = None;
        self.last_digest = None;
    }

    pub fn process(&mut self, image: &ImageRGBA, t: f64) -> TmImageResult {
        self.stats.images += 1;
        let tracking = self
            .previous
            .filter(|&(_, tp)| t - tp < 500.0)
            .map(|(l, _)| l);
        let Some(loc) = locate_tm(image, tracking.as_ref()) else {
            self.previous = None;
            return TmImageResult::empty();
        };
        self.process_located(image, &loc, t, false)
    }

    /// Same thing, the grid being ALREADY located (mosaic: one location per
    /// cell). `count`: counts the image (true by default in TS).
    pub fn process_located(
        &mut self,
        image: &ImageRGBA,
        measured: &Location,
        t: f64,
        count: bool,
    ) -> TmImageResult {
        if count {
            self.stats.images += 1;
        }
        let mixed_fraction = if self.stats.located > 20 {
            self.stats.mixed_count as f64 / self.stats.located as f64
        } else {
            0.0
        };
        let loc = self.geometry.retain(measured, t);
        self.previous = Some((loc, t));
        self.stats.located += 1;
        let sub = Arc::new(analyze_subframe(image, &loc));
        if sub.type_ != SubframeKind::Mixed {
            self.saturation[rank(sub.type_)] = Some((sub.saturation, t));
        }
        // The "saturated" advice is about the recent R/P couple, not the single image.
        let mut saturation = 0f64;
        for &(v, ts) in self.saturation.iter().flatten() {
            if t - ts < 1000.0 {
                saturation = saturation.max(v);
            }
        }
        let mut result = TmImageResult {
            location: Some(loc),
            subframe: Some(sub.clone()),
            advice: framing_advice(Some(&loc), Some(saturation), mixed_fraction),
            frame: None,
            invalid_pair: false,
        };
        if sub.type_ == SubframeKind::R {
            self.geometry.refine_from_r(measured);
        }
        if sub.type_ == SubframeKind::Mixed {
            self.stats.mixed_count += 1;
            self.next_p.clear();
            return result;
        }
        if self.averaging && self.average(&sub, t, &mut result) {
            let type_ = sub.type_;
            self.last_type = Some(type_);
            self.last[rank(type_)] = Some(Dated { sub, t });
            return result;
        }
        let type_ = sub.type_;
        self.last[rank(type_)] = Some(Dated {
            sub: sub.clone(),
            t,
        });
        let toggle = self.last_type.is_some_and(|d| d != type_);
        self.last_type = Some(type_);
        if !toggle {
            return result;
        }
        let Some(other) = self.last[1 - rank(type_)].as_ref() else {
            return result;
        };
        if t - other.t > self.validity_duration {
            return result;
        }
        let (r, p) = if type_ == SubframeKind::R {
            (sub.clone(), other.sub.clone())
        } else {
            (other.sub.clone(), sub.clone())
        };
        self.stats.pairs += 1;
        let measurement = measure_tm_pair(&r, &p);
        for &codec in &self.codecs {
            let Ok(decision) = decide_tm(&measurement.soft, codec) else {
                continue;
            };
            if read_frame(&decision.bytes).is_err() {
                continue;
            }
            self.stats.valid_count += 1;
            let digest = crc32(&decision.bytes);
            let is_new = Some(digest) != self.last_digest;
            self.last_digest = Some(digest);
            result.frame = Some(TmReceivedFrame {
                bytes: decision.bytes,
                codec,
                is_new,
                confidence: decision.mean_confidence,
                measurement,
            });
            return result;
        }
        result.invalid_pair = true;
        result
    }

    /// Decodes the frame of an (R, P) pair; None if no mode validates it.
    fn decoder(&mut self, r: &TmSubframe, p: &TmSubframe) -> Option<TmReceivedFrame> {
        let measurement = measure_tm_pair(r, p);
        for &codec in &self.codecs {
            let Ok(decision) = decide_tm(&measurement.soft, codec) else {
                continue;
            };
            if read_frame(&decision.bytes).is_err() {
                continue;
            }
            let digest = crc32(&decision.bytes);
            let is_new = Some(digest) != self.last_digest;
            self.last_digest = Some(digest);
            return Some(TmReceivedFrame {
                bytes: decision.bytes,
                codec,
                is_new,
                confidence: decision.mean_confidence,
                measurement,
            });
        }
        None
    }

    /// Averaging (see `TmReceiverOptions::averaging`). True if a valid frame
    /// was produced — pairing at the switch is then useless.
    fn average(
        &mut self,
        sub: &Arc<TmSubframe>,
        t: f64,
        result: &mut TmImageResult,
    ) -> bool {
        if sub.type_ == SubframeKind::R {
            self.next_p.clear();
            self.rs.push(Dated {
                sub: sub.clone(),
                t,
            });
            self.rs.retain(|x| t - x.t < 1000.0 && t >= x.t);
            // The grayest R: a brief R keeps a remnant of the previous P.
            let mut sorted: Vec<&Dated> = self.rs.iter().collect();
            js::sort(&mut sorted, |a, b| a.sub.activity - b.sub.activity);
            let half: Vec<&TmSubframe> = sorted[..sorted.len().div_ceil(2)]
                .iter()
                .map(|x| &*x.sub)
                .collect();
            self.r_mean = Some(average_subframes(&half));
            return false;
        }
        // P: same content as the previous one? Otherwise (next batch with no R seen), start over.
        if let Some(last) = self.next_p.last() {
            if subframe_gap(last, sub) > 20.0 {
                self.next_p.clear();
            }
        }
        self.next_p.push(sub.clone());
        if self.next_p.len() > 4 {
            self.next_p.remove(0);
        }
        // The R is the SAME gray for all frames: its mean remains a valid
        // reference as long as the sending lasts (MEAN_REFERENCE_DURATION).
        let Some(r) = self.r_mean.take() else {
            return false;
        };
        let last_r = self.rs.last().map(|x| x.t);
        if last_r.is_none_or(|tr| t - tr > MEAN_REFERENCE_DURATION) {
            self.r_mean = Some(r);
            return false;
        }
        self.stats.pairs += 1;
        let p = average_subframes(&self.next_p.iter().map(|x| &**x).collect::<Vec<_>>());
        let frame = self.decoder(&r, &p);
        self.r_mean = Some(r);
        let Some(frame) = frame else { return false };
        self.stats.valid_count += 1;
        result.frame = Some(frame);
        true
    }
}

#[derive(Debug, Clone)]
struct Cell {
    id: u64,
    x: f64,
    y: f64,
    t: f64,
    created: f64,
    /// Last image where the cell was read as a clean R or P (−∞: never).
    t_clean: f64,
    loc: Location,
    receiver: TmReceiver,
}

/// MOSAIC receiver: several grids in the same image, each carrying its own
/// frame. A "cell" is found again by the position of its top-left marker and
/// has its own R/P pairing. A clean cell NOT found in an image is re-read at
/// its last position if it dates from less than half a second ago (the P
/// subframe blurs the detection).
#[derive(Debug, Clone)]
pub struct TmMosaicReceiver {
    cells: Vec<Cell>,
    next_id: u64,
    options: TmReceiverOptions,
    /// Accumulated over all cells, even forgotten ones.
    pub stats: TmReceiverStats,
}

impl Default for TmMosaicReceiver {
    fn default() -> Self {
        Self::new(TmReceiverOptions::default())
    }
}

impl TmMosaicReceiver {
    pub fn new(options: TmReceiverOptions) -> Self {
        Self {
            cells: Vec::new(),
            next_id: 0,
            options,
            stats: TmReceiverStats::default(),
        }
    }

    /// Currently tracked cells.
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn reset(&mut self) {
        self.cells.clear();
    }

    pub fn process(
        &mut self,
        image: &ImageRGBA,
        locs: &[Location],
        t: f64,
    ) -> Vec<TmImageResult> {
        // Forgotten: silent for 2 s, never clean for 0.5 s, or no longer clean
        // for 1 s (ghosts).
        self.cells.retain(|c| {
            t - c.t < 2000.0
                && if c.t_clean == f64::NEG_INFINITY {
                    t - c.created < 500.0
                } else {
                    t - c.t_clean < 1000.0
                }
        });
        self.stats.images += 1;
        // 1. Assignment (sequential): each grid found joins its cell.
        let mut served: Vec<u64> = Vec::new();
        for loc in locs {
            let [x, y] = loc.markers[0];
            let distance = |k: &Cell| js::hypot(k.x - x, k.y - y) / loc.px_per_module;
            let mut index = self
                .cells
                .iter()
                .position(|k| !served.contains(&k.id) && distance(k) < 12.0);
            if index.is_none() {
                // Overlaps an existing cell: duplicate or ghost, unless the cell in
                // place has never been clean — it is then replaced.
                if let Some(v) = self.cells.iter().position(|k| distance(k) < 30.0) {
                    if served.contains(&self.cells[v].id)
                        || self.cells[v].t_clean != f64::NEG_INFINITY
                    {
                        continue;
                    }
                    self.cells.remove(v);
                }
                let id = self.next_id;
                self.next_id += 1;
                self.cells.push(Cell {
                    id,
                    x,
                    y,
                    t,
                    created: t,
                    t_clean: f64::NEG_INFINITY,
                    loc: *loc,
                    receiver: TmReceiver::new(&self.options),
                });
                index = Some(self.cells.len() - 1);
            }
            let c = &mut self.cells[index.unwrap()];
            c.x = x;
            c.y = y;
            c.t = t;
            c.loc = *loc;
            served.push(c.id);
        }
        // Resume: the clean cells absent from THIS image but seen just now.
        let mut order = served.clone();
        for c in &self.cells {
            if served.contains(&c.id) || t - c.t > 500.0 || t - c.t_clean > 500.0 {
                continue;
            }
            order.push(c.id);
        }
        // 2. Reading: the cells are independent (each has its receiver, the image
        // is only read) — decoded in parallel on all cores. The result is
        // identical to the sequential reading, in the same order.
        let mut targets: Vec<(usize, &mut Cell)> = self
            .cells
            .iter_mut()
            .filter_map(|c| order.iter().position(|&id| id == c.id).map(|rank| (rank, c)))
            .collect();
        let mut read_items: Vec<(usize, TmImageResult)> = read_cells(&mut targets, image, t);
        read_items.sort_by_key(|(rank, _)| *rank);
        let mut results: Vec<TmImageResult> = Vec::with_capacity(read_items.len());
        for (_, r) in read_items {
            Self::count(&mut self.stats, &r);
            results.push(r);
        }
        // Reading order of the mosaic: rows then columns.
        let step = js::min(
            results
                .iter()
                .map(|r| r.location.map_or(f64::INFINITY, |l| l.px_per_module)),
        ) * 20.0;
        js::sort(&mut results, |a, b| {
            let [ax, ay] = a.location.unwrap().markers[0];
            let [bx, by] = b.location.unwrap().markers[0];
            if (ay - by).abs() > step {
                ay - by
            } else {
                ax - bx
            }
        });
        results
    }

    fn count(stats: &mut TmReceiverStats, r: &TmImageResult) {
        stats.located += 1;
        if r.subframe
            .as_ref()
            .is_some_and(|s| s.type_ == SubframeKind::Mixed)
        {
            stats.mixed_count += 1;
        }
        if r.frame.is_some() || r.invalid_pair {
            stats.pairs += 1;
        }
        if r.frame.is_some() {
            stats.valid_count += 1;
        }
    }
}

/// Reads a cell: its receiver decodes the grid at its place in the image.
fn read_cell(c: &mut Cell, image: &ImageRGBA, t: f64) -> TmImageResult {
    let loc = c.loc;
    let r = c.receiver.process_located(image, &loc, t, true);
    if r.subframe
        .as_ref()
        .is_some_and(|s| s.type_ != SubframeKind::Mixed)
    {
        c.t_clean = t;
    }
    r
}

#[cfg(feature = "parallel")]
fn read_cells(targets: &mut [(usize, &mut Cell)], image: &ImageRGBA, t: f64) -> Vec<(usize, TmImageResult)> {
    use rayon::prelude::*;
    if targets.len() < 2 {
        return targets.iter_mut().map(|(rank, c)| (*rank, read_cell(c, image, t))).collect();
    }
    targets.par_iter_mut().map(|(rank, c)| (*rank, read_cell(c, image, t))).collect()
}

#[cfg(not(feature = "parallel"))]
fn read_cells(targets: &mut [(usize, &mut Cell)], image: &ImageRGBA, t: f64) -> Vec<(usize, TmImageResult)> {
    targets.iter_mut().map(|(rank, c)| (*rank, read_cell(c, image, t))).collect()
}
