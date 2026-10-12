package io.github.phuongnse.lyre

import uniffi.lyre_ffi.coreVersion

/** The text of the screen. The web client shows the same text. */
fun coreVersionLabel(): String = "Lyre core ${coreVersion()}"
