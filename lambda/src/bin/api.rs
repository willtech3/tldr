pub use tldr::api::handler;

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    tldr::setup_logging();
    lambda_runtime::run(lambda_runtime::service_fn(handler)).await
}
