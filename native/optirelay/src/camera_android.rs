//! LIVE rear camera (NDK Camera2): YUV 4:2:0 images to Rust,
//! for the viewfinder (reduced preview, rotated to portrait) and for the optical
//! analysis (full image, orp-optics).
//!
//! Pipeline: ACameraManager → rear camera → repeating capture session
//! ("preview" template, continuous focus) → AImageReader YUV_420_888 →
//! `onImageAvailable` callback on the camera thread.

use ndk_sys as ffi;
use std::ffi::{c_void, CStr};
use std::ptr;

#[link(name = "camera2ndk")]
extern "C" {}

/// Planes of a YUV camera image, valid during the callback only.
pub struct CameraImage<'a> {
    pub width: usize,
    pub height: usize,
    #[allow(dead_code)] // sensor timestamp (ns), kept for diagnostics
    pub instant_ns: i64,
    /// Sensor orientation (degrees): 90 on a phone held upright.
    pub orientation: i32,
    y: (&'a [u8], usize),
    u: (&'a [u8], usize, usize),
    v: (&'a [u8], usize, usize),
}

impl CameraImage<'_> {
    #[inline]
    fn rgb(&self, x: usize, y: usize) -> [u8; 3] {
        let yy = self.y.0[y * self.y.1 + x] as f32;
        let (cx, cy) = (x / 2, y / 2);
        let cb = self.u.0.get(cy * self.u.1 + cx * self.u.2).copied().unwrap_or(128) as f32 - 128.0;
        let cr = self.v.0.get(cy * self.v.1 + cx * self.v.2).copied().unwrap_or(128) as f32 - 128.0;
        // Camera: full-range YUV (JFIF, BT.601).
        [
            (yy + 1.402 * cr).clamp(0.0, 255.0) as u8,
            (yy - 0.344_136 * cb - 0.714_136 * cr).clamp(0.0, 255.0) as u8,
            (yy + 1.772 * cb).clamp(0.0, 255.0) as u8,
        ]
    }

    /// Mean (sampled) luminance, for diagnostics.
    pub fn mean_luminance(&self) -> f64 {
        let (mut sum, mut n) = (0u64, 0u64);
        for y in (0..self.height).step_by(16) {
            for x in (0..self.width).step_by(16) {
                sum += self.y.0[y * self.y.1 + x] as u64;
                n += 1;
            }
        }
        sum as f64 / n.max(1) as f64
    }

    /// Dimensions of the image returned by `reduced_rgba(factor)`.
    pub fn reduced_size(&self, factor: usize) -> (usize, usize) {
        (self.width / factor.max(1), self.height / factor.max(1))
    }

    /// RGBA reduced by an integer factor (1: full resolution), in the sensor's
    /// orientation. ×2 reduction: luminance is averaged over 2 × 2, the 4:2:0
    /// chroma is already at that resolution — nothing is lost for the
    /// color. Rows converted in parallel on all cores: in 4K, converting
    /// an image used to cost more than a camera period.
    pub fn reduced_rgba(&self, factor: usize, output: &mut Vec<u8>) {
        use rayon::prelude::*;
        let f = factor.max(1);
        let (l, h) = self.reduced_size(f);
        output.resize(l * h * 4, 255);
        output.par_chunks_mut(l * 4).enumerate().for_each(|(y, line)| {
            for x in 0..l {
                let px = if f == 1 { self.rgb(x, y) } else { self.mean_rgb(x * f, y * f, f) };
                line[x * 4..x * 4 + 3].copy_from_slice(&px);
            }
        });
    }

    /// Mean color of an f × f block (averaged luminance, center chroma).
    #[inline]
    fn mean_rgb(&self, x0: usize, y0: usize, f: usize) -> [u8; 3] {
        let mut sum = 0u32;
        for dy in 0..f {
            let line = (y0 + dy) * self.y.1;
            for dx in 0..f {
                sum += self.y.0[line + x0 + dx] as u32;
            }
        }
        let yy = sum as f32 / (f * f) as f32;
        let (cx, cy) = ((x0 + f / 2) / 2, (y0 + f / 2) / 2);
        let cb = self.u.0.get(cy * self.u.1 + cx * self.u.2).copied().unwrap_or(128) as f32 - 128.0;
        let cr = self.v.0.get(cy * self.v.1 + cx * self.v.2).copied().unwrap_or(128) as f32 - 128.0;
        [
            (yy + 1.402 * cr).clamp(0.0, 255.0) as u8,
            (yy - 0.344_136 * cb - 0.714_136 * cr).clamp(0.0, 255.0) as u8,
            (yy + 1.772 * cb).clamp(0.0, 255.0) as u8,
        ]
    }

    /// RGB preview reduced by a factor `step`, rotated according to the sensor
    /// orientation (portrait): (width, height, RGB bytes).
    pub fn preview(&self, step: usize) -> (u32, u32, Vec<u8>) {
        let (l, h) = (self.width / step, self.height / step);
        let rotated = self.orientation % 180 != 0;
        let (lo, ho) = if rotated { (h, l) } else { (l, h) };
        let mut output = vec![0u8; lo * ho * 3];
        for yo in 0..ho {
            for xo in 0..lo {
                // 90° clockwise rotation: (xo, yo) ← (yo, h − 1 − xo).
                let (xs, ys) = match self.orientation {
                    90 => (yo, h - 1 - xo),
                    270 => (l - 1 - yo, xo),
                    180 => (l - 1 - xo, h - 1 - yo),
                    _ => (xo, yo),
                };
                let o = (yo * lo + xo) * 3;
                output[o..o + 3].copy_from_slice(&self.rgb(xs * step, ys * step));
            }
        }
        (lo as u32, ho as u32, output)
    }
}

type Callback = Box<dyn FnMut(&CameraImage) + Send>;

struct Context {
    reader: *mut ffi::AImageReader,
    orientation: i32,
    callback: Callback,
}

/// An open camera; everything is closed on `drop`.
pub struct LiveCamera {
    handler: *mut ffi::ACameraManager,
    device: *mut ffi::ACameraDevice,
    reader: *mut ffi::AImageReader,
    output: *mut ffi::ACaptureSessionOutput,
    container: *mut ffi::ACaptureSessionOutputContainer,
    destination: *mut ffi::ACameraOutputTarget,
    request: *mut ffi::ACaptureRequest,
    session: *mut ffi::ACameraCaptureSession,
    context: *mut Context,
    // Callbacks kept alive as long as the camera is.
    _device_state: Box<ffi::ACameraDevice_StateCallbacks>,
    _session_state: Box<ffi::ACameraCaptureSession_stateCallbacks>,
    _listener: Box<ffi::AImageReader_ImageListener>,
}

unsafe extern "C" fn device_disconnected(_c: *mut c_void, _d: *mut ffi::ACameraDevice) {
    crate::engine::log("camera disconnected");
}
unsafe extern "C" fn device_error(_c: *mut c_void, _d: *mut ffi::ACameraDevice, error: i32) {
    crate::engine::log(&format!("camera error: {error}"));
}
unsafe extern "C" fn session_state(_c: *mut c_void, _s: *mut ffi::ACameraCaptureSession) {}

unsafe extern "C" fn image_available(context: *mut c_void, _reader: *mut ffi::AImageReader) {
    let ctx = &mut *(context as *mut Context);
    let mut image = ptr::null_mut();
    if ffi::AImageReader_acquireLatestImage(ctx.reader, &mut image).0 != 0 || image.is_null() {
        return;
    }
    let mut l = 0;
    let mut h = 0;
    let mut t = 0;
    ffi::AImage_getWidth(image, &mut l);
    ffi::AImage_getHeight(image, &mut h);
    ffi::AImage_getTimestamp(image, &mut t);
    let plan = |i: i32| -> (&[u8], usize, usize) {
        let mut data = ptr::null_mut();
        let mut length = 0;
        let mut row_step = 0;
        let mut pixel_step = 0;
        ffi::AImage_getPlaneData(image, i, &mut data, &mut length);
        ffi::AImage_getPlaneRowStride(image, i, &mut row_step);
        ffi::AImage_getPlanePixelStride(image, i, &mut pixel_step);
        if data.is_null() {
            return (&[], 0, 1);
        }
        (std::slice::from_raw_parts(data, length as usize), row_step as usize, pixel_step.max(1) as usize)
    };
    let (y, u, v) = (plan(0), plan(1), plan(2));
    if !y.0.is_empty() {
        let view = CameraImage {
            width: l as usize,
            height: h as usize,
            instant_ns: t,
            orientation: ctx.orientation,
            y: (y.0, y.1),
            u,
            v,
        };
        (ctx.callback)(&view);
    }
    ffi::AImage_delete(image);
}

/// Orientation of the open sensor (degrees), to rotate coordinates.
pub static ORIENTATION: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(90);
/// Size of the open stream: width << 32 | height.
pub static SIZE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Largest 16:9 YUV output of the sensor under `lmax × hmax` (fallback:
/// 1,920 × 1,080), and fastest frame-rate range up to `cadence_max`
/// (a fixed range is preferred: an exposure that does not lengthen in low light
/// keeps the subframes apart).
///
/// SAFETY: `handler` alive, `id` a valid camera identifier.
unsafe fn size_and_frame_rate(handler: *mut ffi::ACameraManager, id: &CStr, lmax: i32, hmax: i32, cadence_max: i32) -> ((i32, i32), Option<[i32; 2]>) {
    let mut size = (1920, 1080);
    let mut cadence = None;
    let mut meta = ptr::null_mut();
    if ffi::ACameraManager_getCameraCharacteristics(handler, id.as_ptr(), &mut meta).0 != 0 {
        return (size, cadence);
    }
    let mut input: ffi::ACameraMetadata_const_entry = std::mem::zeroed();
    if ffi::ACameraMetadata_getConstEntry(meta, ffi::acamera_metadata_tag::ACAMERA_SCALER_AVAILABLE_STREAM_CONFIGURATIONS.0, &mut input).0 == 0 {
        let v = std::slice::from_raw_parts(input.data.i32_, input.count as usize);
        let yuv = ffi::AIMAGE_FORMATS::AIMAGE_FORMAT_YUV_420_888.0 as i32;
        let mut best_fit = 0;
        for c in v.chunks_exact(4) {
            let (format, l, h, input_only) = (c[0], c[1], c[2], c[3]);
            if format == yuv && input_only == 0 && l * 9 == h * 16 && l <= lmax && h <= hmax && l > best_fit {
                best_fit = l;
                size = (l, h);
            }
        }
    }
    if ffi::ACameraMetadata_getConstEntry(meta, ffi::acamera_metadata_tag::ACAMERA_CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES.0, &mut input).0 == 0 {
        let v = std::slice::from_raw_parts(input.data.i32_, input.count as usize);
        let mut best_fit: Option<[i32; 2]> = None;
        for p in v.chunks_exact(2) {
            let (min, max) = (p[0], p[1]);
            if max > cadence_max {
                continue;
            }
            let better = match best_fit {
                None => true,
                Some([bmin, bmax]) => max > bmax || (max == bmax && min > bmin),
            };
            if better {
                best_fit = Some([min, max]);
            }
        }
        cadence = best_fit;
    }
    ffi::ACameraMetadata_free(meta);
    (size, cadence)
}

impl LiveCamera {
    /// Locks (or releases) white balance and exposure: once the
    /// grid is framed, colors no longer drift from one image to the next.
    pub fn set_lock(&mut self, locked: bool) -> bool {
        // SAFETY: request and session alive as long as the camera is.
        unsafe {
            let ae = if locked { ffi::acamera_metadata_enum_acamera_control_ae_lock::ACAMERA_CONTROL_AE_LOCK_ON.0 as u8 } else { 0 };
            let awb = if locked { ffi::acamera_metadata_enum_acamera_control_awb_lock::ACAMERA_CONTROL_AWB_LOCK_ON.0 as u8 } else { 0 };
            ffi::ACaptureRequest_setEntry_u8(self.request, ffi::acamera_metadata_tag::ACAMERA_CONTROL_AE_LOCK.0, 1, &ae);
            ffi::ACaptureRequest_setEntry_u8(self.request, ffi::acamera_metadata_tag::ACAMERA_CONTROL_AWB_LOCK.0, 1, &awb);
            let mut requests = [self.request];
            ffi::ACameraCaptureSession_setRepeatingRequest(self.session, ptr::null_mut(), 1, requests.as_mut_ptr(), ptr::null_mut()).0 == 0
        }
    }

    /// Opens the rear camera at the largest 16:9 size it can
    /// deliver in YUV without exceeding `width × height` (landscape, sensor
    /// orientation), at the highest frame rate up to `cadence_max` fps.
    pub fn open(width: i32, height: i32, cadence_max: i32, callback: Callback) -> Result<Self, String> {
        // SAFETY: NDK API; resources closed by Drop (or here on failure).
        unsafe {
            let handler = ffi::ACameraManager_create();
            let mut list = ptr::null_mut();
            ffi::ACameraManager_getCameraIdList(handler, &mut list);
            let mut chosen = None;
            if !list.is_null() {
                let ids = std::slice::from_raw_parts((*list).cameraIds, (*list).numCameras.max(0) as usize);
                for &id in ids {
                    let mut meta = ptr::null_mut();
                    if ffi::ACameraManager_getCameraCharacteristics(handler, id, &mut meta).0 != 0 {
                        continue;
                    }
                    let mut input: ffi::ACameraMetadata_const_entry = std::mem::zeroed();
                    let back = ffi::ACameraMetadata_getConstEntry(meta, ffi::acamera_metadata_tag::ACAMERA_LENS_FACING.0, &mut input).0 == 0
                        && *input.data.u8_ == ffi::acamera_metadata_enum_acamera_lens_facing::ACAMERA_LENS_FACING_BACK.0 as u8;
                    let mut orientation = 90;
                    if ffi::ACameraMetadata_getConstEntry(meta, ffi::acamera_metadata_tag::ACAMERA_SENSOR_ORIENTATION.0, &mut input).0 == 0 {
                        orientation = *input.data.i32_;
                    }
                    ffi::ACameraMetadata_free(meta);
                    if back {
                        chosen = Some((CStr::from_ptr(id).to_owned(), orientation));
                        break;
                    }
                }
                ffi::ACameraManager_deleteCameraIdList(list);
            }
            if let Some((_, o)) = &chosen {
                ORIENTATION.store(*o, std::sync::atomic::Ordering::SeqCst);
            }
            let Some((id, orientation)) = chosen else {
                ffi::ACameraManager_delete(handler);
                return Err("no rear camera".into());
            };

            let ((width, height), cadence) = size_and_frame_rate(handler, &id, width, height, cadence_max);
            SIZE.store(((width as i64) << 32) | height as i64, std::sync::atomic::Ordering::SeqCst);
            let mut reader = ptr::null_mut();
            if ffi::AImageReader_new(width, height, ffi::AIMAGE_FORMATS::AIMAGE_FORMAT_YUV_420_888.0 as i32, 3, &mut reader).0 != 0 {
                ffi::ACameraManager_delete(handler);
                return Err("camera ImageReader unavailable".into());
            }
            let context = Box::into_raw(Box::new(Context { reader, orientation, callback }));
            let mut listener = Box::new(ffi::AImageReader_ImageListener { context: context.cast(), onImageAvailable: Some(image_available) });
            ffi::AImageReader_setImageListener(reader, &mut *listener);
            let mut window = ptr::null_mut();
            ffi::AImageReader_getWindow(reader, &mut window);

            let mut device_state = Box::new(ffi::ACameraDevice_StateCallbacks {
                context: ptr::null_mut(),
                onDisconnected: Some(device_disconnected),
                onError: Some(device_error),
            });
            let mut device = ptr::null_mut();
            let status = ffi::ACameraManager_openCamera(handler, id.as_ptr(), &mut *device_state, &mut device);
            let mut camera = LiveCamera {
                handler,
                device,
                reader,
                output: ptr::null_mut(),
                container: ptr::null_mut(),
                destination: ptr::null_mut(),
                request: ptr::null_mut(),
                session: ptr::null_mut(),
                context,
                _device_state: device_state,
                _session_state: Box::new(ffi::ACameraCaptureSession_stateCallbacks {
                    context: ptr::null_mut(),
                    onClosed: Some(session_state),
                    onReady: Some(session_state),
                    onActive: Some(session_state),
                }),
                _listener: listener,
            };
            if status.0 != 0 || device.is_null() {
                return Err(format!("camera refused (code {}): permission granted?", status.0));
            }
            ffi::ACaptureSessionOutputContainer_create(&mut camera.container);
            ffi::ACaptureSessionOutput_create(window, &mut camera.output);
            ffi::ACaptureSessionOutputContainer_add(camera.container, camera.output);
            ffi::ACameraOutputTarget_create(window, &mut camera.destination);
            ffi::ACameraDevice_createCaptureRequest(camera.device, ffi::ACameraDevice_request_template::TEMPLATE_PREVIEW, &mut camera.request);
            ffi::ACaptureRequest_addTarget(camera.request, camera.destination);
            let focus = ffi::acamera_metadata_enum_acamera_control_af_mode::ACAMERA_CONTROL_AF_MODE_CONTINUOUS_VIDEO.0 as u8;
            ffi::ACaptureRequest_setEntry_u8(camera.request, ffi::acamera_metadata_tag::ACAMERA_CONTROL_AF_MODE.0, 1, &focus);
            if let Some(range) = cadence {
                ffi::ACaptureRequest_setEntry_i32(camera.request, ffi::acamera_metadata_tag::ACAMERA_CONTROL_AE_TARGET_FPS_RANGE.0, 2, range.as_ptr());
            }
            let status = ffi::ACameraDevice_createCaptureSession(camera.device, camera.container, &*camera._session_state, &mut camera.session);
            if status.0 != 0 {
                return Err(format!("camera session refused (code {})", status.0));
            }
            let mut requests = [camera.request];
            let status = ffi::ACameraCaptureSession_setRepeatingRequest(camera.session, ptr::null_mut(), 1, requests.as_mut_ptr(), ptr::null_mut());
            if status.0 != 0 {
                return Err(format!("repeating capture refused (code {})", status.0));
            }
            Ok(camera)
        }
    }
}

impl Drop for LiveCamera {
    fn drop(&mut self) {
        // SAFETY: each resource is freed only once, in reverse order.
        unsafe {
            if !self.session.is_null() {
                ffi::ACameraCaptureSession_close(self.session);
            }
            if !self.request.is_null() {
                ffi::ACaptureRequest_free(self.request);
            }
            if !self.destination.is_null() {
                ffi::ACameraOutputTarget_free(self.destination);
            }
            if !self.output.is_null() {
                ffi::ACaptureSessionOutput_free(self.output);
            }
            if !self.container.is_null() {
                ffi::ACaptureSessionOutputContainer_free(self.container);
            }
            if !self.device.is_null() {
                ffi::ACameraDevice_close(self.device);
            }
            ffi::AImageReader_delete(self.reader);
            ffi::ACameraManager_delete(self.handler);
            drop(Box::from_raw(self.context));
        }
    }
}
