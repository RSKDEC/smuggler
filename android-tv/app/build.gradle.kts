plugins {
    id("com.android.application")
}

android {
    namespace = "com.rskdec.smugglertv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.rskdec.smugglertv"
        minSdk = 24
        targetSdk = 35
        // CI run number, so each new build installs over the previous one.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"
    }

    // Sideload-only key, committed so every build can update the installed app.
    // Use a private key (kept out of git) before publishing to the Play Store.
    signingConfigs {
        create("sideload") {
            storeFile = file("smuggler-tv.keystore")
            storePassword = "smuggler-tv"
            keyAlias = "smuggler-tv"
            keyPassword = "smuggler-tv"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
