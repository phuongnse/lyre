//! WebAssembly bindings of the Lyre core, for the web client.

use wasm_bindgen::prelude::wasm_bindgen;

/// The version of the Lyre core.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
}

#[cfg(test)]
mod tests {
    use super::core_version;

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }
}
