package io.github.phuongnse.lyre

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Android app runs no models (D27), so the generated Kotlin bindings of
 * the core must not export alignment or the model check.
 */
class BindingsTest {
    @Test
    fun bindingsExportNoAlignmentOrModelCheck() {
        // Gradle runs the tests in the module directory.
        val bindings = File("src/main/java/uniffi/lyre_ffi/lyre_ffi.kt").readText()
        val removed = listOf("fun align(", "fun startModelCheck(", "ModelCheck", "AlignedSyllable", "AlignmentFault")
        for (name in removed) {
            assertTrue("The bindings export '$name', which the Android app does not use", !bindings.contains(name))
        }
    }
}
