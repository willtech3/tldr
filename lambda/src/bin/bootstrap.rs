// This is the shared Lambda bootstrap entry point
// It conditionally compiles to either the API or Worker function based on features

// Include the actual implementation files
#[cfg(feature = "api")]
#[path = "api.rs"]
mod api;

#[cfg(feature = "worker")]
#[path = "worker.rs"]
mod worker;

use lambda_runtime::{Error, run, service_fn};
use serde_json::Value;
use lambda_runtime::LambdaEvent;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize tracing
    tracing_subscriber::fmt::init();
    
    // Run the appropriate function handler based on features
    #[cfg(feature = "api")]
    {
        return run(service_fn(api::function_handler)).await;
    }

    #[cfg(feature = "worker")]
    {
        return run(service_fn(worker::function_handler)).await;
    }

    // This code path will only be hit if neither feature is enabled
    #[cfg(not(any(feature = "api", feature = "worker")))]
    {
        panic!("Either 'api' or 'worker' feature must be enabled");
    }
}
