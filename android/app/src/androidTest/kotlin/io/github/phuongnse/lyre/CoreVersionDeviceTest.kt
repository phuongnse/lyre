package io.github.phuongnse.lyre

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.lyre_ffi.coreVersion

@RunWith(AndroidJUnit4::class)
class CoreVersionDeviceTest {
    /** The version in `core/Cargo.toml`, which Gradle passes in as an instrumentation argument. */
    private fun expectedVersion(): String? = InstrumentationRegistry.getArguments().getString("coreVersion")

    @Test
    fun coreReportsTheWorkspaceVersionOnTheDevice() {
        val expected = expectedVersion()
        assertNotNull(expected)
        assertEquals(expected, coreVersion())
    }

    @Test
    fun screenLabelShowsTheCoreVersionOnTheDevice() {
        val expected = expectedVersion()
        assertNotNull(expected)
        assertEquals("Lyre core $expected", coreVersionLabel())
    }
}
