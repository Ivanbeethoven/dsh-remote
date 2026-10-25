plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.dsh.bridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.dsh.bridge"
        minSdk = 29          // SslCertificate.getX509Certificate() needs Android 10
        targetSdk = 34
        versionCode = 6
        versionName = "0.3.3"

        // ---- change these three when you redeploy -------------------------------
        // The relay's public URL.
        buildConfigField("String", "RELAY_BASE", "\"https://relay.example.com:8443\"")
        // The relay access key (relay.accessToken in the plugin config). Stable across
        // DSH restarts — the app fetches the changing launch token itself.
        buildConfigField("String", "ACCESS_KEY", "\"REPLACE_WITH_YOUR_ACCESS_KEY\"")
        // SHA-256 fingerprint of the relay's certificate, so a substituted one is refused.
        buildConfigField(
            "String",
            "RELAY_CERT_SHA256",
            "\"REPLACE_WITH_RELAY_CERT_SHA256\"",
        )
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// No AndroidX, no Kotlin stdlib beyond what the plugin already provides: the whole app is
// one Activity and one WebView.
dependencies {
}
