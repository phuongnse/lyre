package io.github.phuongnse.lyre

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import uniffi.lyre_ffi.coreVersion
import java.io.File

class CoreVersionTest {
    /** The version in the `[workspace.package]` section of `core/Cargo.toml`. */
    private fun workspaceVersion(): String? {
        // Gradle runs the tests in the module directory.
        val manifest = File("../../core/Cargo.toml").readText()
        val section = Regex("""(?m)^\[workspace\.package]\n((?:(?!\[).*\n?)*)""").find(manifest)?.groupValues?.get(1)
        return section?.let { Regex("""(?m)^version\s*=\s*"([^"]+)"""").find(it)?.groupValues?.get(1) }
    }

    @Test
    fun coreReportsTheWorkspaceVersion() {
        val expected = workspaceVersion()
        assertNotNull(expected)
        assertEquals(expected, coreVersion())
    }

    @Test
    fun screenLabelShowsTheCoreVersion() {
        val expected = workspaceVersion()
        assertNotNull(expected)
        assertEquals("Lyre core $expected", coreVersionLabel())
    }
}
