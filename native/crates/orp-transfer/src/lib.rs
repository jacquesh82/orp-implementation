//! Headless ORP transfer — the core of the native app, testable on a PC:
//! - `file`: packing of name + type + bytes (file.ts);
//! - `pairing`: pairing frames and the bench passphrase (tm.ts);
//! - `reading`: ADAPTIVE reading of a video, frame by frame (video.ts);
//! - `receiving`: the receiver state machine (apps/web, trameRecue).

pub mod pairing;
pub mod framing;
pub mod calibration;
pub mod sending;
pub mod state;
pub mod file;
pub mod reading;
pub mod receiving;

pub use framing::FramingSmoother;
pub use pairing::{pairing_payload, is_pairing_frame, BENCH_PASSPHRASE};
pub use calibration::{code_calibration, read_calibration_code, calibration_frame, PAUSE_CALIBRATION, CalibrationMeasurement, TrialResult, CALIBRATION_SERIES_DURATION, CALIBRATION_TRIALS, SUBFRAME_PERIODS, MAX_COLUMNS};
pub use sending::{batch_images, pairing_frame, pairing_frame_with_state, Sender, SendSettings};
pub use state::{clock, read_state, advised_symbols, SenderSummary, SendingState, SenderTracker};
pub use file::{unpack, pack, TransferredFile};
pub use reading::{AdaptiveReader, ReadingProgress, CODE_TIMEOUT, CODE_NOT_READ_MESSAGE};
pub use receiving::{block_summary, advised_duration, block_view, BlockSummary, Event, ReceivePhase, Receiver};
