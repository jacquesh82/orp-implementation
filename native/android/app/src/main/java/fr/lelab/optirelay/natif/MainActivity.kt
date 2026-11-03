package fr.lelab.optirelay.natif

import android.Manifest
import android.app.NativeActivity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.MediaStore
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Host of the Rust application (Slint UI, ORP protocol, NDK camera): a
 * NativeActivity that loads `liboptirelay.so` (meta-data
 * android.app.lib_name). Everything else is Rust; this shim only keeps what
 * a native activity cannot do from Rust without an activity callback or the
 * UI thread:
 *  - the camera permission (its answer comes through onRequestPermissionsResult);
 *  - the file picker for sending (its result comes through onActivityResult);
 *  - saving the received file to Downloads (MediaStore) and sharing it
 *    (FileProvider + share sheet);
 *  - full brightness while sending (window attributes: UI thread only).
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
        private const val FILE_REQUEST = 3

        /** Maximum size of a send: beyond it, the screen would take hours. */
        private const val MAX_SIZE = 4 * 1024 * 1024

        /** Answer to the camera permission request. */
        @JvmStatic
        external fun cameraPermissionResult(granted: Boolean)

        /** File chosen for sending (name, MIME type, bytes). */
        @JvmStatic
        external fun fileChosen(name: String, type: String, bytes: ByteArray)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Near-black app: light system bar icons.
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
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

    /** Called from Rust (JNI): pick the file to send. */
    fun chooseFile() {
        runOnUiThread {
            val pickIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            @Suppress("DEPRECATION")
            startActivityForResult(pickIntent, FILE_REQUEST)
        }
    }

    /** Called from Rust (JNI): full brightness while sending (the grid must be readable). */
    fun maxBrightness(max: Boolean) {
        runOnUiThread {
            window.attributes = window.attributes.apply {
                screenBrightness = if (max) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
        }
    }

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
        if (code == FILE_REQUEST) {
            val uri = data?.data
            if (result == RESULT_OK && uri != null) Thread { readFile(uri) }.start()
        }
    }
}
