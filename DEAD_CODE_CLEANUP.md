### Dead code cleanup plan

This document identifies dead code in the repository and proposes concrete cleanup steps. Confidence is greater than 95%, based on in-repo references, build entrypoints, and deployment artifacts.

## Entry points and deploy artifacts (ground truth)

- The crate declares two binaries only: `tldr-api` and `tldr-worker`.

```toml
# lambda/Cargo.toml
[[bin]]
name = "tldr-api"
path = "src/bin/api.rs"
required-features = ["api"]

[[bin]]
name = "tldr-worker"
path = "src/bin/bootstrap.rs"
required-features = ["worker"]
```

- The CDK deploy packages only those two binaries as Lambda assets.

```ts
// cdk/lib/tldr-stack.ts
const tldrApiFunction = new lambda.Function(this, 'TldrApiFunction', {
  runtime: lambda.Runtime.PROVIDED_AL2,
  handler: 'bootstrap',
  code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr-api/function.zip')),
  ...
});
...
const tldrWorkerFunction = new lambda.Function(this, 'TldrWorkerFunction', {
  runtime: lambda.Runtime.PROVIDED_AL2,
  handler: 'bootstrap',
  code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/target/lambda/tldr-worker/function.zip')),
  ...
});
```

Conclusion: any other binary or entrypoint is not packaged or deployed.

## Findings and justifications

- Unused binary `lambda/src/main.rs`
  - Evidence it’s not packaged/deployed: only `tldr-api` and `tldr-worker` are produced and shipped (see Cargo.toml and CDK above).
  - It defines an entirely separate handler and its own `SlackBot`/`SlackError`, duplicating functionality in the library, and is not referenced by tests or infrastructure. Practically unreachable in the deployed system.
  - Action: remove `lambda/src/main.rs`.

- Unused API branch in `bootstrap.rs`
  - `bootstrap.rs` conditionally includes `api` and `worker`, but only the `worker`-feature build is declared for this file in Cargo.toml. There is no binary that compiles `bootstrap.rs` with feature `api`.
  - Action: remove the `#[cfg(feature = "api")]` include and branch from `bootstrap.rs`.

- Dead `main()` inside `worker.rs`
  - `worker.rs` is included as a module by `bootstrap.rs`; its own `#[tokio::main] async fn main()` is not a binary entrypoint and is never called.
  - Action: delete the dead `main()` function at the bottom of `worker.rs`.

- Unused helper in `api.rs`: `get_latest_message_ts`
  - Defined but never referenced anywhere in the repo.
  - Action: remove the function and the now-unneeded `use tldr::SlackBot;` import and any other imports made redundant by its removal.

- Unused public methods on `tldr::SlackBot`
  - `delete_message` and `replace_original_message` are public but never used by any binary or test.
  - Action: remove these methods or annotate them with `#[allow(dead_code)]` if you want to keep them for a near-term planned feature. If removed, also remove their exclusive helpers if any become unused.

- Unused domain module: `domains/messaging`
  - Not referenced by any code or tests; only re-exported via `lib.rs`.
  - Action: remove `lambda/src/domains/` entirely and the `pub mod domains;` line in `lambda/src/lib.rs`.

## Recommended cleanup steps

1. Remove entire unused binary `lambda/src/main.rs`.
2. In `lambda/src/bin/bootstrap.rs`:
   - Remove the `#[cfg(feature = "api")]` include and branch; keep only the `worker` path.
3. In `lambda/src/bin/worker.rs`:
   - Delete the dead `#[tokio::main] async fn main()` at the bottom of the file.
4. In `lambda/src/bin/api.rs`:
   - Remove `get_latest_message_ts` and the unused imports (`use tldr::SlackBot;`, and any others that become unused) made unnecessary by its removal.
5. In `lambda/src/bot.rs`:
   - Remove `delete_message` and `replace_original_message`; or mark with `#[allow(dead_code)]` if intentionally kept for near-term usage.
6. Remove the unused `lambda/src/domains/` module and the `pub mod domains;` export from `lambda/src/lib.rs`.
7. Run build and tests; ensure zero warnings:
   - `cargo clippy -- -D warnings`
   - `cargo test`
8. If any re-exports in `lambda/src/lib.rs` become unused after removal, prune them for a minimal public API.

## Safety/impact notes

- No deployed Lambda artifact references the removed code paths.
- Tests cover the remaining public API (`prompt`, `response`, `formatting`, `estimate_tokens`, logging init), which remain intact.
- Removing `domains` and unused SlackBot methods reduces surface area without altering current behavior.

## Optional follow-ups

- If you want a single bootstrap for both functions, you can make `bootstrap.rs` the path for both bins and pass features accordingly; otherwise, consolidating to the current explicit two-entrypoint setup is simpler and clearer.
- Consider reducing the `openai-api-rs` dependency usage in `bot.rs` if it’s only used as local data structs for prompt assembly.
