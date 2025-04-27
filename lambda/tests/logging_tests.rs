use tldr::setup_logging;

#[test]
fn test_logging_setup() {
    // This test verifies that the logging setup function doesn't panic
    // We catch any panics in a controlled way to isolate this test
    let result = std::panic::catch_unwind(|| {
        // Call the setup_logging function
        setup_logging();
    });
    
    // The test passes if no panic occurred
    assert!(result.is_ok(), "setup_logging function should not panic");
}

// Note: We can't fully test the actual logging output here as that would
// require capturing stdout/stderr or examining log files, which is more 
// complex than needed for this test. The primary goal is to ensure the
// function can be called without errors.
