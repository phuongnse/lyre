plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "io.github.phuongnse.lyre"
    compileSdk =
        libs.versions.compileSdk
            .get()
            .toInt()
    ndkVersion = libs.versions.ndk.get()

    defaultConfig {
        applicationId = "io.github.phuongnse.lyre"
        minSdk =
            libs.versions.minSdk
                .get()
                .toInt()
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    // The generated bindings call the native library through JNA. Android needs the AAR.
    implementation(variantOf(libs.jna) { artifactType("aar") })

    // The JVM unit tests need the desktop JNA library, which loads the host build of the core.
    testImplementation(libs.jna)
    testImplementation(libs.junit)
}

tasks.withType<Test>().configureEach {
    systemProperty("jna.library.path", rootDir.resolve("../core/target/debug").absolutePath)
}
