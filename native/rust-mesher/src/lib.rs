//! native/rust-mesher/src/lib.rs
//! 
//! Native Rust module stub — pending implementation.
//! Will be compiled to a .node native addon via napi-rs.

#![allow(unused)]

use napi_derive::napi;

/// Version check — used by the TypeScript side to verify the native module loaded
#[napi]
pub fn version() -> String {
    format!("{} v{}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}
