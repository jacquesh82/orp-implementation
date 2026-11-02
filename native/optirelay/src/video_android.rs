//! Reads a video (240 fps slow motion filmed by SlowMotionActivity) frame by
//! frame, ALL frames in order, at the pace of the analysis — the native
//! equivalent of `lireVideoTM` (WebCodecs) in packages/browser.
//!
//! MediaExtractor (MP4 demuxing) → MediaCodec (hardware H.264 / H.265
//! decoder) in BUFFER mode: the decoder outputs YUV 4:2:0 in memory, semi-
//! planar (NV12) or planar (I420), with its row stride and its slice
//! height. (Rendering to an ImageReader surface, the Qualcomm decoder keeps its
//! proprietary compressed format, UBWC, unreadable by the CPU.)

use ndk_sys as ffi;
use std::ffi::CStr;
use std::ptr;

/// Layout of the YUV bytes of a decoded image.
#[derive(Clone, Copy, Debug)]
struct Disposition {
    width: usize,
    height: usize,
    /// Stride of a luminance row (bytes).
    step: usize,
    /// Rows allocated per luminance plane (≥ height).
    slice_height: usize,
    /// Crop: top-left corner of the useful image.
    left: usize,
    top: usize,
    /// True: I420 (U then V); false: NV12 (interleaved UV).
    planar: bool,
}

/// A decoded image; conversion to RGBA is only done on request
/// (images skipped by adaptive reading only cost the decoding).
pub struct VideoImage<'a> {
    pub instant_ms: f64,
    /// Duration of the video (ms), for progress.
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
    data: &'a [u8],
    disposition: Disposition,
    buffer: &'a mut Vec<u8>,
}

impl VideoImage<'_> {
    /// RGBA written into `output` (reused from one image to the next: no allocation).
    pub fn rgba_into(&mut self, output: &mut Vec<u8>) {
        std::mem::swap(self.buffer, output);
        self.rgba();
        std::mem::swap(self.buffer, output);
    }

    /// RGBA (BT.709, limited range — phones' HD video), `width × height × 4`.
    pub fn rgba(&mut self) -> &[u8] {
        let d = self.disposition;
        let (l, h) = (d.width, d.height);
        self.buffer.resize(l * h * 4, 255);
        let y_size = d.step * d.slice_height;
        let src = self.data;
        if src.len() < y_size + (d.height / 2) * d.step / 2 {
            return self.buffer;
        }
        let output = self.buffer.as_mut_slice();
        let step_c = if d.planar { d.step / 2 } else { d.step };
        let u_start = y_size;
        let v_start = if d.planar { y_size + step_c * d.slice_height / 2 } else { y_size + 1 };
        let pixel_step_c = if d.planar { 1 } else { 2 };
        for j in 0..h {
            let jy = j + d.top;
            let jc = jy / 2;
            let y_row = &src[jy * d.step + d.left..jy * d.step + d.left + l];
            let row_offset = &mut output[j * l * 4..(j + 1) * l * 4];
            for i in 0..l {
                let ic = (i + d.left) / 2 * pixel_step_c;
                let cb = src.get(u_start + jc * step_c + ic).copied().unwrap_or(128) as f32 - 128.0;
                let cr = src.get(v_start + jc * step_c + ic).copied().unwrap_or(128) as f32 - 128.0;
                let yy = (y_row[i] as f32 - 16.0) * 1.164_383;
                let o = i * 4;
                row_offset[o] = (yy + 1.792_741 * cr).clamp(0.0, 255.0) as u8;
                row_offset[o + 1] = (yy - 0.213_249 * cb - 0.532_909 * cr).clamp(0.0, 255.0) as u8;
                row_offset[o + 2] = (yy + 2.112_402 * cb).clamp(0.0, 255.0) as u8;
            }
        }
        self.buffer
    }
}

pub struct VideoInfo {
    pub images: u64,
    pub duration_s: f64,
    pub width: u32,
    pub height: u32,
}

/// MediaCodec color formats (MediaCodecInfo.CodecCapabilities).
const COLOR_I420: i32 = 19; // COLOR_FormatYUV420Planar
const COLOR_FLEXIBLE: i32 = 0x7F42_0888; // COLOR_FormatYUV420Flexible

unsafe fn integer(format: *mut ffi::AMediaFormat, key: *const std::os::raw::c_char) -> Option<i32> {
    let mut v = 0;
    ffi::AMediaFormat_getInt32(format, key, &mut v).then_some(v)
}

unsafe fn disposition(format: *mut ffi::AMediaFormat, width: i32, height: i32) -> Disposition {
    let l = integer(format, ffi::AMEDIAFORMAT_KEY_WIDTH).unwrap_or(width);
    let h = integer(format, ffi::AMEDIAFORMAT_KEY_HEIGHT).unwrap_or(height);
    let step = integer(format, ffi::AMEDIAFORMAT_KEY_STRIDE).filter(|&p| p >= l).unwrap_or(l);
    let slice_height = integer(format, ffi::AMEDIAFORMAT_KEY_SLICE_HEIGHT).filter(|&t| t >= h).unwrap_or(h);
    let color = integer(format, ffi::AMEDIAFORMAT_KEY_COLOR_FORMAT).unwrap_or(0);
    let (mut g, mut top, mut d, mut b) = (0, 0, l - 1, h - 1);
    if !ffi::AMediaFormat_getRect(format, ffi::AMEDIAFORMAT_KEY_DISPLAY_CROP, &mut g, &mut top, &mut d, &mut b) {
        (g, top, d, b) = (0, 0, l - 1, h - 1);
    }
    Disposition {
        width: (d - g + 1) as usize,
        height: (b - top + 1) as usize,
        step: step as usize,
        slice_height: slice_height as usize,
        left: g as usize,
        top: top as usize,
        planar: color == COLOR_I420,
    }
}

/// Reads the video at `path`; `on_image` receives each image in order and
/// returns `false` to stop (cancellation).
pub fn read_video(path: &str, mut on_image: impl FnMut(&mut VideoImage) -> bool) -> Result<VideoInfo, String> {
    // File descriptor opened HERE: a bare path goes through the media service,
    // which is not allowed to read the app's private files.
    let file = std::fs::File::open(path).map_err(|e| format!("video not found ({path}): {e}"))?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    use std::os::fd::AsRawFd;
    // SAFETY: NDK API; every resource is freed by Release.
    unsafe {
        let extractor = ffi::AMediaExtractor_new();
        let _l1 = Release(move || {
            ffi::AMediaExtractor_delete(extractor);
        });
        let status = ffi::AMediaExtractor_setDataSourceFd(extractor, file.as_raw_fd(), 0, length as i64);
        if status.0 != 0 {
            return Err(format!("unreadable video ({path}): code {}", status.0));
        }
        // First video track.
        let mut track = None;
        for i in 0..ffi::AMediaExtractor_getTrackCount(extractor) {
            let format = ffi::AMediaExtractor_getTrackFormat(extractor, i);
            let mut mime = ptr::null();
            ffi::AMediaFormat_getString(format, ffi::AMEDIAFORMAT_KEY_MIME, &mut mime);
            if !mime.is_null() && CStr::from_ptr(mime).to_bytes().starts_with(b"video/") {
                track = Some((i, format, CStr::from_ptr(mime).to_owned()));
                break;
            }
            ffi::AMediaFormat_delete(format);
        }
        let (index, format, mime) = track.ok_or("no video track")?;
        let _l2 = Release(move || {
            ffi::AMediaFormat_delete(format);
        });
        ffi::AMediaExtractor_selectTrack(extractor, index);
        let width = integer(format, ffi::AMEDIAFORMAT_KEY_WIDTH).unwrap_or(0);
        let height = integer(format, ffi::AMEDIAFORMAT_KEY_HEIGHT).unwrap_or(0);
        let mut duration_us = 0i64;
        ffi::AMediaFormat_getInt64(format, ffi::AMEDIAFORMAT_KEY_DURATION, &mut duration_us);

        let codec = ffi::AMediaCodec_createDecoderByType(mime.as_ptr());
        if codec.is_null() {
            return Err(format!("no decoder for {}", mime.to_string_lossy()));
        }
        let _l3 = Release(move || {
            ffi::AMediaCodec_stop(codec);
            ffi::AMediaCodec_delete(codec);
        });
        // Output in memory, "flexible" YUV 4:2:0 (NV12 or I420 in practice).
        ffi::AMediaFormat_setInt32(format, ffi::AMEDIAFORMAT_KEY_COLOR_FORMAT, COLOR_FLEXIBLE);
        if ffi::AMediaCodec_configure(codec, format, ptr::null_mut(), ptr::null_mut(), 0).0 != 0 || ffi::AMediaCodec_start(codec).0 != 0 {
            return Err("decoder: configuration refused".into());
        }

        let mut available = disposition(format, width, height);
        let mut buffer = Vec::new();
        let mut images = 0u64;
        let mut input_end = false;
        let mut info = ffi::AMediaCodecBufferInfo { offset: 0, size: 0, presentationTimeUs: 0, flags: 0 };
        loop {
            if !input_end {
                let i = ffi::AMediaCodec_dequeueInputBuffer(codec, 2_000);
                if i >= 0 {
                    let mut capacity = 0usize;
                    let input = ffi::AMediaCodec_getInputBuffer(codec, i as usize, &mut capacity);
                    let size = ffi::AMediaExtractor_readSampleData(extractor, input, capacity);
                    if size < 0 {
                        ffi::AMediaCodec_queueInputBuffer(codec, i as usize, 0, 0, 0, ffi::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM as u32);
                        input_end = true;
                    } else {
                        let instant = ffi::AMediaExtractor_getSampleTime(extractor).max(0) as u64;
                        ffi::AMediaCodec_queueInputBuffer(codec, i as usize, 0, size as usize, instant, 0);
                        ffi::AMediaExtractor_advance(extractor);
                    }
                }
            }
            let o = ffi::AMediaCodec_dequeueOutputBuffer(codec, &mut info, 5_000);
            if o == ffi::AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED as isize {
                let output = ffi::AMediaCodec_getOutputFormat(codec);
                available = disposition(output, width, height);
                crate::engine::log(&format!("decoder output format: {available:?}"));
                ffi::AMediaFormat_delete(output);
                continue;
            }
            if o < 0 {
                continue;
            }
            let end = info.flags & ffi::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM as u32 != 0;
            let mut keep_going = true;
            if info.size > 0 {
                let mut size = 0usize;
                let base = ffi::AMediaCodec_getOutputBuffer(codec, o as usize, &mut size);
                if !base.is_null() {
                    let data = std::slice::from_raw_parts(base.add(info.offset as usize), info.size as usize);
                    let mut view = VideoImage {
                        instant_ms: info.presentationTimeUs as f64 / 1000.0,
                        duration_ms: duration_us as f64 / 1000.0,
                        width: available.width as u32,
                        height: available.height as u32,
                        data,
                        disposition: available,
                        buffer: &mut buffer,
                    };
                    images += 1;
                    keep_going = on_image(&mut view);
                }
            }
            ffi::AMediaCodec_releaseOutputBuffer(codec, o as usize, false);
            if !keep_going {
                return Err("reading cancelled".into());
            }
            if end {
                break;
            }
        }
        Ok(VideoInfo { images, duration_s: duration_us as f64 / 1e6, width: width as u32, height: height as u32 })
    }
}

/// Frees an NDK resource when it goes out of scope (including on error).
struct Release<F: FnMut()>(F);

impl<F: FnMut()> Drop for Release<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}
