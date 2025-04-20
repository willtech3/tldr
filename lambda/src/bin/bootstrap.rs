// This is the shared Lambda bootstrap entry point
// It conditionally compiles to either the API or Worker function based on features

#[cfg(feature = "api")]
mod api_bootstrap {
    // Re-export the main function from api.rs
    pub use crate::api::main;
}

#[cfg(feature = "worker")]
mod worker_bootstrap {
    // Re-export the main function from worker.rs
    pub use crate::worker::main;
}

// Include the actual implementation files
#[cfg(feature = "api")]
#[path = "api.rs"]
mod api;

#[cfg(feature = "worker")]
#[path = "worker.rs"]
mod worker;

#[tokio::main]
async fn main() -> lambda_runtime::Error {
    // Call the appropriate main function based on features
    #[cfg(feature = "api")]
    {
        api_bootstrap::main().await
    }

    #[cfg(feature = "worker")]
    {
        worker_bootstrap::main().await
    }

    // This code path will only be hit if neither feature is enabled
    #[cfg(not(any(feature = "api", feature = "worker")))]
    {
        panic!("Either 'api' or 'worker' feature must be enabled")
    }
}
