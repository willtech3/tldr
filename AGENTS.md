### Agent Environment Guide (ChatGPT Codex, Google Jules)

This repository includes scripts to prepare a clean, non-interactive environment so coding agents can run code quality checks, tests, and project tasks via the `justfile` reliably.

---

### What agents should do first

1) Bootstrap dependencies

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

- `just` command runner
- Node.js 20+ with `npm`
- `bolt-ts/` dependencies installed via `npm ci`
- Terraform (>= 1.10) available, with providers pre-fetched (`terraform init -backend=false`)

If installation is not possible (e.g., no root in the container), the scripts emit clear guidance and continue where feasible.

---

### Project task cheat-sheet

- Default quality gate: `just qa`
  - Runs: `bolt-build`, `bolt-bundle`, `bolt-lint`, `bolt-test`, `tf-fmt`, `tf-validate`
- Individual recipes:
  - `just bolt-build` – Type-check the Lambda
  - `just bolt-bundle` – Produce the deployable bundle via esbuild
  - `just bolt-lint` – ESLint with strict TypeScript rules
  - `just bolt-test` – Jest unit tests
  - `just tf-fmt` – Check Terraform formatting (`terraform fmt -check`)
  - `just tf-validate` – Offline Terraform validation (no AWS creds)

---

### Minimal secrets/environment

Quality checks and tests run without external secrets. For local integration runs or deployments, provide:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- `ANTHROPIC_API_KEY` (optionally `ANTHROPIC_MODEL` to override the default `claude-opus-4-8`)

For Terraform workflows, see `terraform/terraform.tfvars.example` and `terraform/README.md`.

---

### Notes for specific agents

- ChatGPT Codex (web): In the Codex UI, connect your GitHub repo, create an environment, then run the scripts above inside the environment shell.
- Google Jules: In `jules.google`, connect the GitHub repo/branch and use these scripts as first commands in the job plan to ensure dependencies before executing tasks.

If network access is restricted during task execution, run `./scripts/agent-setup.sh` while network is allowed so caches are primed.

---

### Cursor Cloud specific instructions

- There is no dev server and no `start` process. The check to run is `just qa` (build, Lambda bundle, lint, Jest, `terraform fmt -check`, offline `terraform validate`). It does not need Slack, Anthropic, or AWS credentials.
- The base image supplies Node.js 20+ (`.nvmrc` is `20`; `engines` allows `>=20`). Cloud Agent install puts `just` and Terraform 1.14.5 — the version in `.github/workflows/deploy.yml` — on `/usr/local/bin`. `./scripts/agent-setup.sh` installs npm dependencies and initializes providers; it does not install `just` or Terraform when apt has neither.
- To smoke the Lambda without AWS, run `just bolt-build`, then invoke `bolt-ts/dist/index.js` `handler` with an API Gateway event whose body is a Slack `url_verification` payload signed with `SLACK_SIGNING_SECRET`. Dummy `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `ANTHROPIC_API_KEY` values are enough. Bolt calls `auth.test` in the background; a dummy token returns `invalid_auth` and the challenge response is unchanged.

### Documentation standards

When working with checklists in project documentation files (markdown), use the following emoji conventions:
- ✅ — Completed item (green checkmark)
- ☐ — Incomplete/pending item (empty white box)

When completing tasks from a checklist, update the checkbox emoji from ☐ to ✅ to reflect progress.
