### Agent Environment Guide (ChatGPT Codex, Google Jules)

This repository includes scripts to prepare a clean, non-interactive environment that lets coding agents like ChatGPT Codex (web) and Google Jules run code quality checks, tests, and project tasks via the `justfile` reliably.

---

### What agents should do first

1) Bootstrap dependencies and caches

```bash
./scripts/agent-setup.sh
```

2) Run the full code quality suite

```bash
./scripts/agent-run-qa.sh
```

Both steps are idempotent and safe to re-run.

---

### What these scripts ensure

- Rust toolchain (stable, edition 2024) with `rustfmt` and `clippy`
- `just` command runner to execute recipes in the root `justfile`
- Node.js 18+ with `npm`, and `cdk/` dependencies installed via `npm ci`
- Warmed Cargo and npm caches to speed up subsequent runs

If installation is not possible (e.g., no root in the container), the scripts will emit clear guidance and continue where feasible.

---

### Project task cheat-sheet

- Default quality gate: `just qa`
  - Runs: `fmt-check`, `check`, `clippy`, `test`, then `cdk-build` (TypeScript)
- Individual recipes:
  - `just fmt-check` – Rust formatting check
  - `just check` – Fast Rust compile check
  - `just clippy` – Strict lints (`-D warnings -W clippy::pedantic`)
  - `just test` – Run Rust tests (including doc tests)
  - `just cdk-build` – Build the AWS CDK TypeScript app under `cdk/`

---

### Minimal secrets/environment

Quality checks and tests run without external secrets. For local integration runs or deployments, provide:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- `OPENAI_API_KEY` (and optional `OPENAI_ORG_ID`)

For CDK workflows, see `cdk/env.example` and create `cdk/.env` accordingly.

---

### Notes for specific agents

- ChatGPT Codex (web): In the Codex UI, connect your GitHub repo, create an environment, then run the scripts above inside the environment shell. See: `help.openai.com` (Codex getting started) and community guides describing "Create environment" and GitHub connector steps.
- Google Jules: In `jules.google` (public beta), connect the GitHub repo/branch and use these scripts as first commands in the job plan to ensure dependencies before executing tasks.

If network access is restricted during task execution, run `./scripts/agent-setup.sh` while network is allowed so caches are primed.

---

### Documentation standards

When working with checklists in project documentation files (markdown), use the following emoji conventions:
- ✅ — Completed item (green checkmark)
- ☐ — Incomplete/pending item (empty white box)

When completing tasks from a checklist, update the checkbox emoji from ☐ to ✅ to reflect progress.
