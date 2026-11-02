//! JNI bridge with the Kotlin host (`MainActivity`, NativeActivity): what only
//! Android's Java API offers — slow-motion shooting in a high-speed session,
//! camera permission, color of the system bar icons.
//!
//! Rust → Kotlin: method calls on the activity (`ndk_context`).
//! Kotlin → Rust: the `Java_…` functions below, brought back onto the Slint
//! event loop by `invoke_from_event_loop`.

use jni::objects::{JClass, JObject, JString, JValue};
use jni::sys::jboolean;
use jni::{JNIEnv, JavaVM};

#[link(name = "log")]
extern "C" {
    fn __android_log_write(priority: i32, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> i32;
}

/// Writes to logcat (tag "OptiRelay"): `adb logcat -s OptiRelay`.
pub fn log(message: &str) {
    let text = std::ffi::CString::new(message.replace('\0', " ")).unwrap_or_default();
    // SAFETY: valid, NUL-terminated C strings.
    unsafe { __android_log_write(4, c"OptiRelay".as_ptr(), text.as_ptr()) };
}

/// The Android application (android-activity), kept to reach the activity.
static ANDROID_APP: std::sync::OnceLock<slint::android::AndroidApp> = std::sync::OnceLock::new();

pub fn retain(app: slint::android::AndroidApp) {
    let _ = ANDROID_APP.set(app);
}

fn with_activity<R>(f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<R>) -> Option<R> {
    let context = ndk_context::android_context();
    // SAFETY: pointers provided by android-activity for the whole life of the app.
    let vm = match unsafe { JavaVM::from_raw(context.vm().cast()) } {
        Ok(vm) => vm,
        Err(e) => {
            log(&format!("JNI: virtual machine not found: {e}"));
            return None;
        }
    };
    let mut env = match vm.attach_current_thread() {
        Ok(env) => env,
        Err(e) => {
            log(&format!("JNI: could not attach thread: {e}"));
            return None;
        }
    };
    // The ACTIVITY (MainActivity), not ndk_context's application context.
    let Some(android_app) = ANDROID_APP.get() else {
        log("JNI: unknown activity");
        return None;
    };
    let activity = unsafe { JObject::from_raw(android_app.activity_as_ptr().cast()) };
    match f(&mut env, &activity) {
        Ok(r) => Some(r),
        Err(e) => {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            log(&format!("JNI: {e}"));
            None
        }
    }
}

/// Opens the slow-motion shooting screen; the result comes back through `slowMotionFinished`.
/// `target`: advised duration (s, 0 if none), towards which the bar
/// fills; `instruction`: text shown before filming.
pub fn film_slow_motion(max_seconds: i32, target: i32, instruction: &str) {
    with_activity(|env, a| {
        let instruction = env.new_string(instruction)?;
        env.call_method(a, "filmSlowMotion", "(IILjava/lang/String;)V", &[JValue::Int(max_seconds), JValue::Int(target), (&instruction).into()])
            .map(|_| ())
    });
}

/// Requests the camera if needed; the answer comes back through `cameraPermissionResult`.
pub fn request_camera() {
    log("requesting camera access");
    with_activity(|env, a| env.call_method(a, "requestCamera", "()V", &[]).map(|_| ()));
}

/// System bar icons: dark on a light screen, light on a dark screen.
pub fn light_bars(light: bool) {
    with_activity(|env, a| env.call_method(a, "lightBars", "(Z)V", &[JValue::Bool(light.into())]).map(|_| ()));
}

#[no_mangle]
pub extern "system" fn Java_fr_lelab_optirelay_natif_MainActivity_slowMotionFinished(mut env: JNIEnv, _class: JClass, json: JString) {
    let text: String = env.get_string(&json).map(Into::into).unwrap_or_default();
    let _ = slint::invoke_from_event_loop(move || crate::slow_motion_finished(&text));
}

#[no_mangle]
pub extern "system" fn Java_fr_lelab_optirelay_natif_MainActivity_cameraPermissionResult(_env: JNIEnv, _class: JClass, granted: jboolean) {
    let granted = granted != 0;
    let _ = slint::invoke_from_event_loop(move || crate::camera_permission_result(granted));
}

/// Saves the received file to Downloads (MediaStore, on the Kotlin side).
pub fn save(name: &str, mime_type: &str, bytes: &[u8]) -> bool {
    with_activity(|env, a| {
        let name = env.new_string(name)?;
        let mime_type = env.new_string(mime_type)?;
        let array = env.byte_array_from_slice(bytes)?;
        env.call_method(a, "save", "(Ljava/lang/String;Ljava/lang/String;[B)Z", &[(&name).into(), (&mime_type).into(), (&array).into()])?
            .z()
    })
    .unwrap_or(false)
}

/// Opens the Android file picker; the file comes back through `fileChosen`.
pub fn choose_file() {
    with_activity(|env, a| env.call_method(a, "chooseFile", "()V", &[]).map(|_| ()));
}

/// Screen brightness at maximum while sending (the grid must be readable).
pub fn max_brightness(max: bool) {
    with_activity(|env, a| env.call_method(a, "maxBrightness", "(Z)V", &[JValue::Bool(max.into())]).map(|_| ()));
}

/// Highest refresh rate the screen can display (Hz); 60 if unknown.
pub fn max_frequency() -> f32 {
    with_activity(|env, a| env.call_method(a, "maxFrequency", "()F", &[])?.f()).unwrap_or(60.0)
}

#[no_mangle]
pub extern "system" fn Java_fr_lelab_optirelay_natif_MainActivity_fileChosen(
    mut env: JNIEnv,
    _class: JClass,
    name: JString,
    mime_type: JString,
    bytes: jni::objects::JByteArray,
) {
    let name: String = env.get_string(&name).map(Into::into).unwrap_or_default();
    let mime_type: String = env.get_string(&mime_type).map(Into::into).unwrap_or_default();
    let data = env.convert_byte_array(&bytes).unwrap_or_default();
    let _ = slint::invoke_from_event_loop(move || crate::file_chosen(name, mime_type, data));
}

/// Offers the received file to other apps (Android share sheet).
pub fn share(name: &str, mime_type: &str, bytes: &[u8]) -> bool {
    with_activity(|env, a| {
        let name = env.new_string(name)?;
        let mime_type = env.new_string(mime_type)?;
        let array = env.byte_array_from_slice(bytes)?;
        env.call_method(a, "share", "(Ljava/lang/String;Ljava/lang/String;[B)Z", &[(&name).into(), (&mime_type).into(), (&array).into()])?
            .z()
    })
    .unwrap_or(false)
}

/// Android video picker; the copied video comes back through `slowMotionFinished`.
pub fn choose_video() {
    with_activity(|env, a| env.call_method(a, "chooseVideo", "()V", &[]).map(|_| ()));
}
