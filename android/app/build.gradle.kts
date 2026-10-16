plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The version in the `[workspace.package]` section of core/Cargo.toml. The device tests run on the emulator, where they cannot read it.
val coreVersion: String =
    rootDir
        .resolve("../core/Cargo.toml")
        .readText()
        .let { Regex("""(?m)^\[workspace\.package]\n((?:(?!\[).*\n?)*)""").find(it)?.groupValues?.get(1) }
        ?.let { Regex("""(?m)^version\s*=\s*"([^"]+)"""").find(it)?.groupValues?.get(1) }
        ?: error("core/Cargo.toml has no workspace version.")

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
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["coreVersion"] = coreVersion
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

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.junit)
}

tasks.withType<Test>().configureEach {
    systemProperty("jna.library.path", rootDir.resolve("../core/target/debug").absolutePath)
}
