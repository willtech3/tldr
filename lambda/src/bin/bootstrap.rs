// This is the Lambda bootstrap entry point for the Worker function

// Include the worker implementation
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

    // Run the worker handler
    #[cfg(feature = "worker")]
    {
        run(service_fn(worker::handler)).await?;
    }
    #[cfg(not(feature = "worker"))]
    {
        panic!("'worker' feature must be enabled");
    }

    Ok(())
}
