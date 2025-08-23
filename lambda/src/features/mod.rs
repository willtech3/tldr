// Legacy shim module retained during rebase; actual modules moved to top-level
pub mod api {
    pub use crate::api::handler;
}
pub mod deliver {
    pub use crate::worker::deliver::*;
}
pub mod summarize {
    pub use crate::worker::summarize::*;
}
pub mod worker {
    pub use crate::worker::handler;
}
