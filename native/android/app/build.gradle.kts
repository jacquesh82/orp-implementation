// Native OptiRelay application: the UI and the protocol are the Rust
// library `liboptirelay.so` (native/optirelay, Slint), loaded by a
// NativeActivity; Kotlin only keeps what needs an activity callback or the
// UI thread (camera permission, file picker, save/share, brightness).
// The library is placed in src/main/jniLibs by ../rebuild.sh.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "fr.lelab.optirelay.natif"
    compileSdk = 35

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    defaultConfig {
        applicationId = "fr.lelab.optirelay.natif"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
}
