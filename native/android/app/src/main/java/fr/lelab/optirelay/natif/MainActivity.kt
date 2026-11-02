package fr.lelab.optirelay.natif

import android.Manifest
import android.app.NativeActivity
import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

/**
 * Host of the Rust (Slint) application: a NativeActivity that loads
 * `liboptirelay.so` (meta-data android.app.lib_name). It only adds what the
 * native API does not offer:
 *  - dark status bar icons (the app has a light background);
 *  - the camera permission;
 *  - slow-motion filming (SlowMotionActivity, Java high-speed session),
 *    requested by Rust (`filmSlowMotion`) and handed back to Rust (`slowMotionFinished`).
 */
class MainActivity : NativeActivity() {

    companion object {
        init {
            // NativeActivity opens the library with dlopen, outside the JVM:
            // without this load, the `external` methods below cannot be
            // found (UnsatisfiedLinkError). Same file, loaded once.
            System.loadLibrary("optirelay")
        }

        private const val CAMERA_REQUEST = 1
        private const val SLOW_MOTION_REQUEST = 2

        /** Filming result, as JSON (url/path, frame rate, size, duration — or error). */
        @JvmStatic
        external fun slowMotionFinished(json: String)

        /** Answer to the camera permission request. */
        @JvmStatic
        external fun cameraPermissionResult(granted: Boolean)

        /** File chosen for sending (name, MIME type, bytes). */
        @JvmStatic
        external fun fileChosen(name: String, type: String, bytes: ByteArray)

        private const val FILE_REQUEST = 3
        private const val VIDEO_REQUEST = 4
        /** Maximum size of a send: beyond it, the screen would take hours. */
        private const val MAX_SIZE = 4 * 1024 * 1024
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
    }

    override fun onResume() {
        super.onResume()
        // Test without filming: `adb shell am start -n fr.lelab.optirelay.natif/.MainActivity
        // --es video <path>` reads that video as if it were a slow-motion clip just filmed.
        // Send test without the picker: `--es send <path>`.
        intent?.getStringExtra("send")?.let { path ->
            intent.removeExtra("send")
            window.decorView.postDelayed({
                val f = java.io.File(path)
                if (f.exists()) fileChosen(f.name, "image/jpeg".takeIf { path.endsWith(".jpg") } ?: "application/octet-stream", f.readBytes())
            }, 1500)
        }
        // Transfer test without filming: `--es test <path>`.
        intent?.getStringExtra("test")?.let { path ->
            intent.removeExtra("test")
            window.decorView.postDelayed({
                slowMotionFinished(JSONObject().put("path", path).put("test", true).toString())
            }, 1500)
        }
        // Calibration test without filming: `--es calibration <path>`.
        intent?.getStringExtra("calibration")?.let { path ->
            intent.removeExtra("calibration")
            window.decorView.postDelayed({
                slowMotionFinished(JSONObject().put("path", path).put("calibration", true).toString())
            }, 1500)
        }
        val video = intent?.getStringExtra("video") ?: return
        intent.removeExtra("video")
        window.decorView.postDelayed({
            slowMotionFinished(JSONObject().put("path", video).put("frameRate", 240).put("duration", 0).toString())
        }, 1500)
    }

    override fun onNewIntent(new: Intent) {
        super.onNewIntent(new)
        intent = new
    }

    /** Called from Rust (JNI): light system bars (light screens) or dark ones. */
    fun lightBars(light: Boolean) {
        runOnUiThread {
            WindowInsetsControllerCompat(window, window.decorView).apply {
                isAppearanceLightStatusBars = light
                isAppearanceLightNavigationBars = light
            }
        }
    }

    /** Called from Rust (JNI): requests the camera if needed; answers through cameraPermissionResult. */
    fun requestCamera() {
        runOnUiThread {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                cameraPermissionResult(true)
            } else {
                requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
            }
        }
    }

    /** Called from Rust (JNI): opens the slow-motion filming screen (target 0: none). */
    fun filmSlowMotion(maxSeconds: Int, target: Int, instruction: String) {
        runOnUiThread {
            @Suppress("DEPRECATION")
            startActivityForResult(
                Intent(this, SlowMotionActivity::class.java)
                    .putExtra(SlowMotionActivity.EXTRA_SECONDS, maxSeconds)
                    .putExtra(SlowMotionActivity.EXTRA_TARGET, target)
                    .putExtra(SlowMotionActivity.EXTRA_INSTRUCTION, instruction.ifBlank { null }),
                SLOW_MOTION_REQUEST,
            )
        }
    }

    /** Called from Rust (JNI): pick the file to send. */
    fun chooseFile() {
        runOnUiThread {
            val pickIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            @Suppress("DEPRECATION")
            startActivityForResult(pickIntent, FILE_REQUEST)
        }
    }

    /** Called from Rust (JNI): pick an already filmed video to read. */
    fun chooseVideo() {
        runOnUiThread {
            val pickIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("video/*")
            @Suppress("DEPRECATION")
            startActivityForResult(pickIntent, VIDEO_REQUEST)
        }
    }

    /** Copies the chosen video into the cache (Rust reads it by file descriptor), then has it read. */
    private fun importVideo(uri: android.net.Uri) {
        try {
            val dir = java.io.File(cacheDir, "slowmotion").apply { mkdirs() }
            val destination = java.io.File(dir, "import-${System.currentTimeMillis()}.mp4")
            contentResolver.openInputStream(uri)!!.use { input -> destination.outputStream().use { input.copyTo(it) } }
            slowMotionFinished(JSONObject().put("path", destination.absolutePath).put("duration", 0).toString())
        } catch (e: Exception) {
            slowMotionFinished(JSONObject().put("error", "Unreadable video: ${e.message}").toString())
        }
    }

    /**
     * Called from Rust (JNI): maximum brightness while sending, and the
     * screen at its highest refresh rate (120 Hz on adaptive screens, which
     * otherwise drop back to 60 Hz) — shorter subframes stay sharp.
     */
    fun maxBrightness(max: Boolean) {
        runOnUiThread {
            window.attributes = window.attributes.apply {
                screenBrightness = if (max) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                preferredDisplayModeId = if (max) fastestMode()?.modeId ?: 0 else 0
            }
        }
    }

    /** Fastest display mode at the current resolution. */
    @Suppress("DEPRECATION")
    private fun fastestMode(): android.view.Display.Mode? {
        val screen = windowManager.defaultDisplay
        val current = screen.mode
        return screen.supportedModes
            .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
            .maxByOrNull { it.refreshRate }
    }

    /** Called from Rust (JNI): highest refresh rate of the screen (Hz). */
    @Suppress("DEPRECATION")
    fun maxFrequency(): Float = fastestMode()?.refreshRate ?: windowManager.defaultDisplay.refreshRate

    private fun readFile(uri: android.net.Uri) {
        try {
            var name = "file"
            contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) name = c.getString(0) ?: name
            }
            val type = contentResolver.getType(uri) ?: "application/octet-stream"
            val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            if (bytes.size > MAX_SIZE) {
                android.util.Log.w("OptiRelay", "file too large: ${bytes.size} bytes")
                return
            }
            fileChosen(name, type, bytes)
        } catch (e: Exception) {
            android.util.Log.w("OptiRelay", "cannot read the file: ${e.message}")
        }
    }

    /** Called from Rust (JNI): offers the received file to other apps (share sheet). */
    fun share(name: String, type: String, bytes: ByteArray): Boolean = try {
        val dir = java.io.File(cacheDir, "share").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // only one shared file at a time
        val nameOn = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "optirelay-received.bin" }
        val file = java.io.File(dir, nameOn).apply { writeBytes(bytes) }
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "fr.lelab.optirelay.natif.share", file)
        val send = Intent(Intent.ACTION_SEND)
            .setType(type.ifBlank { "application/octet-stream" })
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runOnUiThread { startActivity(Intent.createChooser(send, nameOn)) }
        true
    } catch (e: Exception) {
        android.util.Log.w("OptiRelay", "share failed: ${e.message}")
        false
    }

    /** Called from Rust (JNI): saves the received file to Downloads. */
    fun save(name: String, type: String, bytes: ByteArray): Boolean = try {
        val nameOn = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "optirelay-received.bin" }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, nameOn)
            put(MediaStore.Downloads.MIME_TYPE, type.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("MediaStore refused the insert")
        contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        contentResolver.update(uri, values, null, null)
        true
    } catch (e: Exception) {
        android.util.Log.w("OptiRelay", "save refused: ${e.message}")
        false
    }

    @Deprecated("Activity API: NativeActivity lacks the AndroidX ActivityResult API.")
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == CAMERA_REQUEST) cameraPermissionResult(results.firstOrNull() == PackageManager.PERMISSION_GRANTED)
    }

    @Deprecated("Activity API: NativeActivity lacks the AndroidX ActivityResult API.")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        super.onActivityResult(code, result, data)
        if (code == VIDEO_REQUEST) {
            val uri = data?.data
            if (result == RESULT_OK && uri != null) Thread { importVideo(uri) }.start()
            return
        }
        if (code == FILE_REQUEST) {
            val uri = data?.data
            if (result == RESULT_OK && uri != null) Thread { readFile(uri) }.start()
            return
        }
        if (code == SLOW_MOTION_REQUEST) {
            val json = data?.getStringExtra(SlowMotionActivity.RESULT)
                ?: JSONObject().put("error", "Filming cancelled.").toString()
            slowMotionFinished(json)
        }
    }
}
