# ---------------------------------------------------------------------------
# One-time adoption of the live resources CDK/CloudFormation created, so the
# first `terraform apply` updates production in place instead of failing on
# name collisions (Lambda, log group) — or worse, recreating the REST API,
# whose id is embedded in the public invoke URL the Slack app manifest points
# at (https://qp4xsgi1h7.execute-api.us-east-2.amazonaws.com/prod).
#
# Import blocks are idempotent: once a resource is in state they are no-ops,
# so steady-state CI applies are unaffected. They can be deleted after the
# first successful post-merge deploy.
#
# IDs captured from the live account (714944708230, us-east-2) on 2026-06-10.
# Cutover sequencing, including TldrStack decommissioning, is documented in
# terraform/README.md ("Migrating from CDK").
#
# Deliberately NOT imported:
#   - aws_api_gateway_deployment.tldr — Terraform creates a fresh deployment
#     and repoints the imported stage in place; the API id never changes.
#   - aws_lambda_permission.api_gateway_invoke — CDK's per-method permissions
#     use generated statement ids; Terraform adds its own statement alongside
#     them. The CDK ones die with the stack (see README decommissioning).
#   - aws_api_gateway_method_settings.prod — PATCH-style resource; "creating"
#     it simply overwrites the same stage settings CDK wrote.
#   - IAM roles — Terraform creates new tldr-* roles and repoints the Lambda;
#     CDK's generated-name roles are retired with the stack.
# ---------------------------------------------------------------------------

import {
  to = aws_cloudwatch_log_group.lambda
  id = "/aws/lambda/tldr-bolt"
}

import {
  to = aws_lambda_function.tldr
  id = "tldr-bolt"
}

import {
  to = aws_api_gateway_rest_api.tldr
  id = "qp4xsgi1h7"
}

import {
  to = aws_api_gateway_resource.slack
  id = "qp4xsgi1h7/zij1yg"
}

import {
  to = aws_api_gateway_resource.interactive
  id = "qp4xsgi1h7/qfi199"
}

import {
  to = aws_api_gateway_resource.events
  id = "qp4xsgi1h7/zcjqyn"
}

import {
  to = aws_api_gateway_method.interactive_post
  id = "qp4xsgi1h7/qfi199/POST"
}

import {
  to = aws_api_gateway_method.events_post
  id = "qp4xsgi1h7/zcjqyn/POST"
}

import {
  to = aws_api_gateway_integration.interactive
  id = "qp4xsgi1h7/qfi199/POST"
}

import {
  to = aws_api_gateway_integration.events
  id = "qp4xsgi1h7/zcjqyn/POST"
}

import {
  to = aws_api_gateway_stage.prod
  id = "qp4xsgi1h7/prod"
}
