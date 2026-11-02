//! Smoothing of the framing advice (packages/browser/src/framing.ts): an R↔P
//! transition image or an isolated advice no longer makes the frame blink;
//! 2 agreeing images to turn green, 4 to leave it.

#[derive(Debug, Default, Clone)]
pub struct FramingSmoother {
    shown: Option<String>,
    candidate: Option<String>,
    repetitions: u32,
}

impl FramingSmoother {
    const TOWARD_GOOD: u32 = 2;
    const TOWARD_BAD: u32 = 4;

    /// `advice`: "" if the image is well framed, the advice otherwise; None for
    /// an image that does not count (transition). Returns the advice to show.
    pub fn track(&mut self, advice: Option<&str>) -> String {
        let Some(advice) = advice else { return self.shown.clone().unwrap_or_default() };
        if self.shown.is_none() || self.shown.as_deref() == Some(advice) {
            self.shown = Some(advice.to_string());
            self.candidate = None;
            self.repetitions = 0;
            return advice.to_string();
        }
        if self.candidate.as_deref() == Some(advice) {
            self.repetitions += 1;
        } else {
            self.candidate = Some(advice.to_string());
            self.repetitions = 1;
        }
        if self.repetitions >= if advice.is_empty() { Self::TOWARD_GOOD } else { Self::TOWARD_BAD } {
            self.shown = Some(advice.to_string());
            self.candidate = None;
            self.repetitions = 0;
        }
        self.shown.clone().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hysteresis() {
        let mut l = FramingSmoother::default();
        assert_eq!(l.track(Some("loin")), "loin");
        assert_eq!(l.track(Some("")), "loin");
        assert_eq!(l.track(None), "loin");
        assert_eq!(l.track(Some("")), "");
        for _ in 0..3 {
            assert_eq!(l.track(Some("loin")), "");
        }
        assert_eq!(l.track(Some("loin")), "loin");
    }
}
