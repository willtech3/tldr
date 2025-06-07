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

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize tracing, explicitly setting the max level to INFO
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Run the appropriate function handler based on features
    #[cfg(feature = "api")]
    {
        run(service_fn(api::handler)).await?;
    }
    #[cfg(feature = "worker")]
    {
        run(service_fn(worker::handler)).await?;
    }
    #[cfg(not(any(feature = "api", feature = "worker")))]
    {
        panic!("Either 'api' or 'worker' feature must be enabled");
    }

    Ok(())
}
