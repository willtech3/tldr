# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the TLDR Slack Bot project.

## What is an ADR?

An Architecture Decision Record is a document that captures an important architectural decision made along with its context and consequences.

## ADR Format

Each ADR follows a consistent format:

- **Title**: Short noun phrase (e.g., "Use Rust for Lambda functions")
- **Status**: Proposed, Accepted, Deprecated, Superseded
- **Context**: What is the issue that we're seeing that motivates this decision?
- **Decision**: What is the change that we're proposing?
- **Consequences**: What becomes easier or more difficult to do because of this change?

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-0001](0001-initial-architecture-assessment.md) | Initial Architecture Assessment and Current State | Accepted | 2025-12-12 |

## Creating a New ADR

1. Copy `template.md` to a new file with the format `NNNN-title-with-dashes.md`
2. Fill in all sections
3. Update this README's index
4. Submit for review

## References

- [ADR GitHub Organization](https://adr.github.io/)
- [Michael Nygard's original blog post](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
