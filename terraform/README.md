# TLDR Infrastructure (Terraform)

This directory provisions the entire TLDR runtime — the equivalent of the former
`cdk/` stack — with Terraform:

- One Node.js 20 Lambda (`tldr-bolt`) — 1 GB memory, 15 min timeout
- API Gateway REST API with `POST /slack/events` and `POST /slack/interactive`
- Lambda IAM execution role with least-privilege `ssm:GetParameter` on the three
  configured SecureString parameters
- CloudWatch log group with 1-week retention
- Account-level API Gateway CloudWatch Logs role (for stage access logging)

## Resource map (CDK → Terraform)

| CDK construct | Terraform |
|---|---|
| `logs.LogGroup` | `aws_cloudwatch_log_group.lambda` |
| `lambda.Function` + `Code.fromAsset` | `aws_lambda_function.tldr` + `data.archive_file.lambda_bundle` |
| auto exec role | `aws_iam_role.lambda` + `aws_iam_role_policy_attachment.lambda_basic_execution` |
| `addToRolePolicy(ssm:GetParameter)` | `aws_iam_role_policy.ssm_parameter_read` |
| `apigateway.RestApi` | `aws_api_gateway_rest_api.tldr` |
| `addResource` / `addMethod` / `LambdaIntegration` | `aws_api_gateway_resource.*` / `aws_api_gateway_method.*` / `aws_api_gateway_integration.*` |
| auto deployment + stage + `deployOptions` | `aws_api_gateway_deployment.tldr` + `aws_api_gateway_stage.prod` + `aws_api_gateway_method_settings.prod` |
| auto CloudWatch role | `aws_iam_role.apigw_cloudwatch` + `aws_api_gateway_account.this` |
| auto invoke permission | `aws_lambda_permission.api_gateway_invoke` |
| `CfnOutput` | `output.api_url` / `output.api_gateway_url` |
| CloudFormation server-side state | S3 backend (`versions.tf`) |

## One-time bootstrap: remote state bucket

Terraform keeps its own state, so create an S3 bucket once (the analogue of
`cdk bootstrap`). Native S3 locking (`use_lockfile`) means no DynamoDB table is
needed (Terraform ≥ 1.10).

```bash
aws s3api create-bucket \
  --bucket <your-tldr-tfstate-bucket> \
  --region us-east-2 \
  --create-bucket-configuration LocationConstraint=us-east-2
aws s3api put-bucket-versioning \
  --bucket <your-tldr-tfstate-bucket> \
  --versioning-configuration Status=Enabled
```

In CI, set the repository variable `TF_STATE_BUCKET` to this bucket name
(optionally `TF_STATE_KEY`, default `tldr/terraform.tfstate`).

## Migrating from CDK (one-time cutover)

Production was originally provisioned by the CDK `TldrStack` (CloudFormation).
`imports.tf` adopts those live resources into Terraform state on the first
apply — the Lambda, its log group, and the REST API (including its resources,
methods, integrations, and `prod` stage) are imported, NOT recreated, so the
api-id and therefore the Slack request URL never change. The import blocks are
idempotent no-ops once state exists and can be deleted after the first
successful deploy.

Expected first-apply diff (anything else — especially a destroy/replace of the
REST API or Lambda — means an import id is wrong; stop and fix):

- `default_tags` (`Project`/`ManagedBy`) added to every imported resource
- Lambda execution role swapped to the new `tldr-bolt-role`
- A new API Gateway deployment (the stage is repointed in place)
- A new `AllowAPIGatewayInvoke` Lambda permission alongside CDK's
- Stage method settings re-written with the same values

### Decommissioning TldrStack (after the first successful Terraform deploy)

The CloudFormation stack still references the now-Terraform-managed resources,
and its template does NOT set `DeletionPolicy: Retain` — a plain
`delete-stack` would destroy production. Retire it with template surgery:

```bash
# 1. Fetch the live template
aws cloudformation get-template --stack-name TldrStack \
  --query TemplateBody --output json > /tmp/tldr-stack.json

# 2. Add  "DeletionPolicy": "Retain"  to EVERY entry under "Resources"
#    (python3 -c 'import json;t=json.load(open("/tmp/tldr-stack.json"));
#    [r.update(DeletionPolicy="Retain") for r in t["Resources"].values()];
#    json.dump(t,open("/tmp/tldr-stack-retain.json","w"))')

# 3. Update the stack with the retain-only template (CFN may report drift
#    from Terraform's role/tag updates — that is expected and harmless)
aws cloudformation update-stack --stack-name TldrStack \
  --template-body file:///tmp/tldr-stack-retain.json --capabilities CAPABILITY_IAM

# 4. Delete the stack; resources are retained
aws cloudformation delete-stack --stack-name TldrStack
aws cloudformation wait stack-delete-complete --stack-name TldrStack

# 5. Verify production is still serving
aws lambda get-function --function-name tldr-bolt
curl -s -o /dev/null -w '%{http_code}\n' \
  https://qp4xsgi1h7.execute-api.us-east-2.amazonaws.com/prod/slack/events  # 403 = alive (no Slack signature)
```

After deletion, clean up CDK leftovers that Terraform does not manage: the
orphaned `TldrStack-TldrBoltFunctionServiceRole-*` execution role, CDK's
per-method Lambda invoke permissions (statement ids prefixed `TldrStack-`),
and — once nothing else uses them — the `cdk-hnb659fds-*` bootstrap roles.

**Never run `cdk deploy` against these resources again** — CloudFormation
would fight Terraform over every imported resource.

## Deploy

Deploys normally run in CI (`.github/workflows/deploy.yml`). To run locally:

```bash
# 1. Build the Lambda bundle that data.archive_file zips
cd ../bolt-ts && npm ci && npm run bundle && cd ../terraform

# 2. Init against the remote state bucket
terraform init \
  -backend-config="bucket=<your-tldr-tfstate-bucket>" \
  -backend-config="key=tldr/terraform.tfstate" \
  -backend-config="region=us-east-2" \
  -backend-config="use_lockfile=true"

# 3. Review + apply (pass vars via terraform.tfvars or TF_VAR_*)
terraform plan
terraform apply

# 4. Grab the URL for the Slack app manifest
terraform output -raw api_gateway_url
```

## Offline validation (no AWS, no state)

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

`data.archive_file` is not evaluated during `validate`, so the bundle need not
exist for this to pass. This is what `just tf-validate` and the CI gate run.

## Configuration

All inputs are documented in `variables.tf`; see `terraform.tfvars.example` for a
starting point. Secrets themselves never live in Terraform — only the SSM
parameter *names* do. The CI workflow syncs the secret *values* into SSM
SecureString parameters on each deploy.
