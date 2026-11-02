package fr.lelab.optirelay.natif

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Range
import android.util.Size
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.Executor

/**
 * SLOW-MOTION filming for OptiRelay: high-speed camera session
 * (CONSTRAINED_HIGH_SPEED_VIDEO, 240 fps at 1080p on the S25 Ultra), which
 * neither getUserMedia nor the WebView can reach. The user aims (preview at
 * the same frame rate), taps “Film”, then “Finish” — or the maximum duration
 * cuts it. The video is handed back to the page, which reads it frame by
 * frame, not in real time (its TM video reader): the sender can shorten its
 * subframes to a single screen refresh.
 *
 * Nothing is interpreted here: we film and hand back a file. No orientation
 * is imposed on the file (the decoder is rotation-insensitive); the screen
 * is locked in PORTRAIT, the phone held upright.
 */
class SlowMotionActivity : ComponentActivity() {

    companion object {
        const val EXTRA_SECONDS = "seconds"
        /** ADVISED duration (s): the bar fills up toward it (0: none). */
        const val EXTRA_TARGET = "target"
        /** Instruction shown before filming (e.g. “the sender must show code …”). */
        const val EXTRA_INSTRUCTION = "instruction"
        const val RESULT = "result"
    }

    private data class Setting(val cameraId: String, val size: Size, val frameRate: Int)

    private lateinit var texture: TextureView
    private lateinit var state: TextView
    private lateinit var button: Button
    private lateinit var duration: ProgressBar
    private lateinit var setting: Setting
    private lateinit var file: File
    private val thread = HandlerThread("slowmotion").apply { start() }
    private val task = Handler(thread.looper)
    private val screen = Handler(Looper.getMainLooper())
    private val executor = Executor { task.post(it) }
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var recorder: MediaRecorder? = null
    private var preview: Surface? = null
    private var startTime = 0L
    private var recorded = false
    private var finished = false
    private var maxSeconds = 20
    private var target = 0
    private var instruction: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Full screen: neither status bar nor navigation bar over the preview.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        maxSeconds = intent.getIntExtra(EXTRA_SECONDS, 20).coerceIn(2, 60)
        target = intent.getIntExtra(EXTRA_TARGET, 0).coerceIn(0, maxSeconds)
        instruction = intent.getStringExtra(EXTRA_INSTRUCTION)

        val frame = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        texture = TextureView(this)
        frame.addView(texture, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        state = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            setBackgroundColor(0x99000000.toInt())
            setPadding(28, 16, 28, 16)
        }
        // Portrait: instruction at the top, below the front camera; buttons at the bottom.
        frame.addView(state, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply { setMargins(32, 130, 32, 0) })
        val cancel = Button(this).apply {
            text = "Cancel"
            setOnClickListener { deliverResult(null, "Filming cancelled.") }
        }
        frame.addView(cancel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply { setMargins(48, 0, 0, 90) })
        button = Button(this).apply {
            text = "Film"
            textSize = 20f
            isEnabled = false
            setOnClickListener { if (recorded) finishRecording() else task.post { startRecording() } }
        }
        frame.addView(button, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, 200, Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, 48, 70) })
        // Filmed duration over the maximum duration: the SENDER tells when to stop (“Enough sent”).
        duration = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progress = 0
            visibility = android.view.View.INVISIBLE
        }
        frame.addView(duration, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 24, Gravity.BOTTOM).apply { setMargins(48, 0, 48, 300) })
        setContentView(frame)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            deliverResult(null, "Camera permission denied.")
            return
        }
        val available = availableSettings()
        if (available == null) {
            deliverResult(null, "This phone does not offer slow-mo to apps.")
            return
        }
        val (fast, sharp) = available
        val highResolution = sharp != null && preferences.getBoolean("resolution", false)
        setting = if (highResolution) sharp!! else fast
        // Frame rate ↔ resolution toggle, while not filming: the activity
        // restarts with the other setting (the camera reopens cleanly).
        if (sharp != null) {
            val other = if (highResolution) fast else sharp
            val toggle = Button(this).apply {
                text = "${other.size.height}p · ${other.frameRate} fps"
                setOnClickListener {
                    if (recorded) return@setOnClickListener
                    preferences.edit().putBoolean("resolution", !highResolution).apply()
                    isEnabled = false
                    // Camera closed BEFORE restarting: the new instance reopens it.
                    task.post {
                        try { session?.close() } catch (_: Exception) {}
                        try { camera?.close() } catch (_: Exception) {}
                        session = null
                        camera = null
                        screen.post { recreate() }
                    }
                }
            }
            frame.addView(toggle, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { setMargins(0, 0, 0, 90) })
        }
        val dir = File(cacheDir, "slowmotion").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // only one recording kept
        file = File(dir, "slowmotion-${System.currentTimeMillis()}.mp4")
        state.text = (instruction ?: "Aim at the sending screen, then tap Film") + " · slow-mo ${setting.frameRate} fps at ${setting.size.height}p"

        texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, l: Int, h: Int) {
                adjustPreview(l, h)
                openCamera()
            }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, l: Int, h: Int) = adjustPreview(l, h)
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture) = true
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
        }
    }

    /**
     * High-speed settings of the main back camera:
     *   FRAME RATE — the highest frame rate, then the largest image (240 fps
     *                at 1080p): subframes down to 8 ms, mosaic ≤ 3 × 3;
     *   RESOLUTION — the largest image filmed at 120 fps at least (4K if the
     *                sensor offers it): subframes ≥ 17 ms, mosaic up to 7 × 7.
     * The second is null when it does not differ from the first.
     */
    private fun availableSettings(): Pair<Setting, Setting?>? {
        val handler = getSystemService(CAMERA_SERVICE) as CameraManager
        for (id in handler.cameraIdList) {
            val c = handler.getCameraCharacteristics(id)
            if (c.get(CameraCharacteristics.LENS_FACING) != CameraCharacteristics.LENS_FACING_BACK) continue
            val capacities = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: continue
            if (!capacities.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO)) continue
            val card = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: continue
            val all = card.highSpeedVideoSizes.flatMap { size ->
                card.getHighSpeedVideoFpsRangesFor(size).filter { it.lower == it.upper }.map { Setting(id, size, it.upper) }
            }
            val pixels = { r: Setting -> r.size.width.toLong() * r.size.height }
            val frameRate = all.maxWithOrNull(compareBy<Setting>({ it.frameRate }, pixels)) ?: continue
            val resolution = all.filter { it.frameRate >= 120 }.maxWithOrNull(compareBy<Setting>(pixels, { it.frameRate }))
            // The first back camera (the main one) is enough.
            return frameRate to resolution?.takeIf { pixels(it) > pixels(frameRate) }
        }
        return null
    }

    private val preferences by lazy { getSharedPreferences("slowmotion", MODE_PRIVATE) }

    private var trials = 0

    @SuppressLint("MissingPermission")
    private fun openCamera() {
        val handler = getSystemService(CAMERA_SERVICE) as CameraManager
        handler.openCamera(setting.cameraId, object : CameraDevice.StateCallback() {
            override fun onOpened(c: CameraDevice) {
                camera = c
                configureTexture()
                openSession(recording = false)
            }

            override fun onDisconnected(c: CameraDevice) {
                c.close()
                deliverResult(null, "Camera disconnected.")
            }

            override fun onError(c: CameraDevice, error: Int) {
                c.close()
                // The page's camera (WebView) is released with a delay: the sensor
                // stays “in use” for a few hundred ms. Retry.
                val busy = error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE
                if (busy && !finished && trials++ < 12) {
                    screen.post { state.text = "Releasing the camera…" }
                    task.postDelayed({ openCamera() }, 250)
                    return
                }
                val reason = when (error) {
                    ERROR_CAMERA_IN_USE, ERROR_MAX_CAMERAS_IN_USE -> "camera in use by another app"
                    ERROR_CAMERA_DISABLED -> "camera disabled by the system"
                    else -> "camera error $error"
                }
                deliverResult(null, "Slow-mo unavailable: $reason.")
            }
        }, task)
    }

    /** Preview surface at the video size. */
    private fun configureTexture() {
        val st = texture.surfaceTexture ?: return
        st.setDefaultBufferSize(setting.size.width, setting.size.height)
        preview = Surface(st)
        screen.post { adjustPreview(texture.width, texture.height) }
    }

    /**
     * Preview WITHOUT distortion. The sensor stream (16:9 landscape) already
     * arrives rotated into the phone's natural frame: in PORTRAIT, it is a
     * 9:16 image that the TextureView stretches over its whole surface. We
     * restore its proportions, centered, black bands at top and bottom. (In
     * landscape, a quarter turn would be needed too: Camera2Basic recipe.)
     */
    private fun adjustPreview(viewWidth: Int, viewHeight: Int) {
        if (!::setting.isInitialized || viewWidth == 0 || viewHeight == 0) return
        val rotation = if (Build.VERSION.SDK_INT >= 30) display?.rotation ?: Surface.ROTATION_0 else @Suppress("DEPRECATION") windowManager.defaultDisplay.rotation
        val view = android.graphics.RectF(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
        val cx = view.centerX()
        val cy = view.centerY()
        val m = android.graphics.Matrix()
        if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) {
            val buffer = android.graphics.RectF(0f, 0f, setting.size.height.toFloat(), setting.size.width.toFloat())
            buffer.offset(cx - buffer.centerX(), cy - buffer.centerY())
            m.setRectToRect(view, buffer, android.graphics.Matrix.ScaleToFit.FILL)
            val scale = minOf(viewHeight.toFloat() / setting.size.height, viewWidth.toFloat() / setting.size.width)
            m.postScale(scale, scale, cx, cy)
            m.postRotate(90f * (rotation - 2), cx, cy)
        } else {
            // 9:16 content (height = long side of the sensor) in the view.
            val contentRatio = setting.size.height.toFloat() / setting.size.width
            val viewRatio = viewWidth.toFloat() / viewHeight
            if (viewRatio > contentRatio) m.setScale(contentRatio / viewRatio, 1f, cx, cy)
            else m.setScale(1f, viewRatio / contentRatio, cx, cy)
            if (rotation == Surface.ROTATION_180) m.postRotate(180f, cx, cy)
        }
        texture.setTransform(m)
    }

    private fun openSession(recording: Boolean) {
        val c = camera ?: return
        val surfaces = mutableListOf(preview ?: return)
        recorder?.let { surfaces.add(it.surface) }
        val config = SessionConfiguration(
            SessionConfiguration.SESSION_HIGH_SPEED,
            surfaces.map { OutputConfiguration(it) },
            executor,
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    session = s
                    val hs = s as CameraConstrainedHighSpeedCaptureSession
                    val request = c.createCaptureRequest(if (recording) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW).apply {
                        surfaces.forEach { addTarget(it) }
                        set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(setting.frameRate, setting.frameRate))
                        // Continuous focus (video): the sending screen is 20–60 cm away.
                        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                    }
                    try {
                        hs.setRepeatingBurst(hs.createHighSpeedRequestList(request.build()), null, task)
                    } catch (e: Exception) {
                        deliverResult(null, "Camera refused slow-mo: ${e.message}")
                        return
                    }
                    if (recording) {
                        recorder?.start()
                        startTime = System.currentTimeMillis()
                        recorded = true
                        screen.post { button.text = "Finish"; button.isEnabled = true; duration.visibility = android.view.View.VISIBLE }
                        screen.post(chrono)
                        screen.postDelayed({ if (recorded) finishRecording() }, maxSeconds * 1000L)
                    } else {
                        screen.post { button.isEnabled = true }
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    deliverResult(null, "Could not start a slow-mo session at ${setting.frameRate} fps.")
                }
            },
        )
        c.createCaptureSession(config)
    }

    private val chrono = object : Runnable {
        override fun run() {
            if (!recorded) return
            val s = (System.currentTimeMillis() - startTime) / 1000.0
            if (target > 0) {
                // Continuing a transfer: the bar heads for the ADVISED duration.
                state.text = if (s < target) "● %.1f s / ≈ %d s advised — keep going, sender in frame".format(Locale.US, s, target)
                else "✓ %.1f s: the ≈ %d s advised are filmed — you can finish".format(Locale.US, s, target)
                duration.progress = (1000 * s / target).toInt().coerceAtMost(1000)
                duration.progressTintList = android.content.res.ColorStateList.valueOf(if (s < target) Color.rgb(91, 141, 239) else Color.rgb(34, 197, 94))
            } else {
                state.text = "● %.1f s — stop when the sender shows “Enough sent”".format(Locale.US, s)
                duration.progress = (1000 * s / maxSeconds).toInt().coerceAtMost(1000)
            }
            screen.postDelayed(this, 100)
        }
    }

    /** On the camera thread: prepares the encoder, then reopens the session with it. */
    private fun startRecording() {
        if (recorded || finished) return
        screen.post { button.isEnabled = false; state.text = "Preparing…" }
        session?.close()
        session = null
        val r = prepareRecorder(MediaRecorder.VideoEncoder.HEVC) ?: prepareRecorder(MediaRecorder.VideoEncoder.H264)
        if (r == null) {
            deliverResult(null, "Video encoder unavailable at ${setting.frameRate} fps.")
            return
        }
        recorder = r
        openSession(recording = true)
    }

    private fun prepareRecorder(encoder: Int): MediaRecorder? {
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setOutputFile(file.absolutePath)
            // High bitrate: compression must not blur the modules.
            // Encoding bitrate scaled to pixels per second: the fine modules of
            // a dense mosaic do not survive strong compression.
            val pixelsPerSecond = setting.size.width.toLong() * setting.size.height * setting.frameRate
            r.setVideoEncodingBitRate(if (pixelsPerSecond > 600_000_000L) 120_000_000 else if (setting.frameRate >= 240) 80_000_000 else 50_000_000)
            r.setVideoFrameRate(setting.frameRate)
            r.setVideoSize(setting.size.width, setting.size.height)
            r.setVideoEncoder(encoder)
            r.prepare()
            r
        } catch (e: Exception) {
            r.release()
            null
        }
    }

    private fun finishRecording() {
        if (!recorded) return
        recorded = false
        screen.post { button.isEnabled = false; state.text = "Finalizing the video…" }
        task.post {
            val duration = (System.currentTimeMillis() - startTime) / 1000.0
            try {
                session?.stopRepeating()
            } catch (_: Exception) {
            }
            val ok = try {
                recorder?.stop()
                true
            } catch (e: Exception) {
                false
            }
            if (!ok || !file.exists() || file.length() == 0L) {
                deliverResult(null, "Empty video: the camera recorded nothing.")
                return@post
            }
            val json = JSONObject()
                .put("path", file.absolutePath) // read directly by the native app
                .put("frameRate", setting.frameRate)
                .put("width", setting.size.width)
                .put("height", setting.size.height)
                .put("duration", duration)
            deliverResult(json, null)
        }
    }

    /** Closes everything and hands the result (or the error) back to MainActivity. */
    private fun deliverResult(result: JSONObject?, error: String?) {
        if (finished) return
        finished = true
        recorded = false
        task.post {
            try { session?.close() } catch (_: Exception) {}
            try { camera?.close() } catch (_: Exception) {}
            try { recorder?.release() } catch (_: Exception) {}
            session = null
            camera = null
            recorder = null
            screen.post {
                val data = Intent().putExtra(RESULT, (result ?: JSONObject().put("error", error)).toString())
                setResult(if (result != null) RESULT_OK else RESULT_CANCELED, data)
                finish()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // Leaving the screen mid-recording keeps the video; otherwise abort.
        if (recorded) finishRecording() else if (!isChangingConfigurations) deliverResult(null, "Filming cancelled.")
    }

    override fun onDestroy() {
        super.onDestroy()
        thread.quitSafely()
    }
}
