//! The reading pipeline of one image, shared by the camera and the video
//! (port of `TmPipeline`, packages/browser/src/tm.ts, without the DOM): grid
//! tracking (`GridTracker`), then the single or the mosaic receiver.

use crate::location::GridTracker;
use crate::tm_receiver::{
    framing_advice, TmReceiverOptions, TmMosaicReceiver, TmReceiver, TmImageResult,
};
use crate::render::ImageRGBA;
use crate::temporal::TM_ALIGNMENT;

/// Valid frames and pairs, single grid and mosaic combined.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PipelineStats {
    pub valid_count: u64,
    pub pairs: u64,
    pub mixed_count: u64,
    pub images: u64,
}

#[derive(Debug, Clone)]
pub struct TmPipeline {
    pub receiver: TmReceiver,
    pub mosaic: TmMosaicReceiver,
    pub tracking: GridTracker,
}

impl Default for TmPipeline {
    fn default() -> Self {
        Self::new(&TmReceiverOptions::default())
    }
}

impl TmPipeline {
    pub fn new(options: &TmReceiverOptions) -> Self {
        Self {
            receiver: TmReceiver::new(options),
            mosaic: TmMosaicReceiver::new(options.clone()),
            tracking: GridTracker::new(Some(TM_ALIGNMENT), 250.0),
        }
    }

    pub fn stats(&self) -> PipelineStats {
        let (a, b) = (&self.receiver.stats, &self.mosaic.stats);
        PipelineStats {
            valid_count: a.valid_count + b.valid_count,
            pairs: a.pairs + b.pairs,
            mixed_count: a.mixed_count + b.mixed_count,
            images: a.images + b.images,
        }
    }

    /// Forgets geometry, cells and pairings (camera reopened, new sending).
    pub fn reset(&mut self) {
        self.receiver.reset();
        self.mosaic.reset();
        self.tracking.forget();
    }

    /// One entry per grid read (at least one: the single grid, located or not).
    pub fn process(&mut self, image: &ImageRGBA, t: f64) -> Vec<TmImageResult> {
        let locs = self.tracking.locate(image, t);
        // Mosaic as soon as one has been seen — even if THIS image shows only
        // one grid (P subframe): R and P of the same cell must stay in the
        // same receiver.
        if locs.len() >= 2 || self.mosaic.cell_count() >= 2 {
            let all = self.mosaic.process(image, locs, t);
            if all.is_empty() {
                return vec![TmImageResult {
                    location: None,
                    subframe: None,
                    advice: framing_advice(None, None, 0.0),
                    frame: None,
                    invalid_pair: false,
                }];
            }
            return all;
        }
        // One grid (or none): the single receiver, which keeps TRACKING the
        // markers from one image to the next.
        match locs.first() {
            Some(loc) => {
                let loc = *loc;
                vec![self.receiver.process_located(image, &loc, t, true)]
            }
            None => vec![self.receiver.process(image, t)],
        }
    }
}
