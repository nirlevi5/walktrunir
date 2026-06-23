# Walktru Semantic Propagation System

Founding Engineer home assignment for designing how a multi-tenant data platform safely corrects an incorrect semantic field definition and propagates that change across a live dependency graph.

## Problem

The shared field `event_timestamp` was documented as a `free_text_string`, but the stored values are actually ISO 8601 calendar dates in UTC (`YYYY-MM-DD`, no time component).

That field feeds downstream DAU metrics, cross-region aggregations, billing deduplication, ML feature tables, and identity joins. Correcting the definition changes the meaning of historical data without changing the bytes on disk, so derived datasets must be identified, recomputed, validated, and promoted in dependency order.

## What This Repo Contains

This is a static documentation site plus the source markdown documents behind it.

| Path | Purpose |
|---|---|
| `index.html` | Root redirect to the documentation site |
| `pages/index.html` | Main navigation page |
| `pages/doc1.html` | Data model write-up with ERD |
| `pages/doc2.html` | AWS architecture write-up with architecture diagram |
| `pages/doc3.html` | End-to-end semantic update flow |
| `pages/flow.html` | Full propagation flow diagram |
| `pages/success_flow_illustration.html` | Table-level success flow illustration |
| `pages/failed_flow_illustration.html` | Table-level failure flow illustration |
| `docs/document_1_data_models.md` | Source markdown for data models |
| `docs/document_2_aws_architecture.md` | Source markdown for AWS architecture |
| `docs/document_3_update_flow.md` | Source markdown for update flow |
| `assets/` | Shared CSS, navigation, and diagram zoom behavior |

## Local Usage

No build step is required. Open `index.html` directly, or serve the repo with any static file server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

The diagrams support pinch/drag zoom, mouse wheel zoom with Ctrl/Cmd, double-click reset, and keyboard reset with `0` or `Escape`.

## Design Summary

The proposed system separates three concerns:

- Dataset registry and serving pointers: what datasets exist, how they are recomputed, and which materialization URI readers currently use.
- Immutable semantic definitions: what each field meant at each version.
- Dataset bindings and lineage: which definition version each dataset was computed against, and which datasets depend on which upstream datasets.

When a correction is submitted, the system:

1. Inserts a new semantic definition version.
2. Retires the old version by linking it with `superseded_by`.
3. Marks all dataset bindings to the old version as stale.
4. Traverses the lineage DAG to find direct and transitive impact.
5. Creates a complete propagation event and task set up front.
6. Recomputes affected datasets in topological order.
7. Promotes validated materializations by updating metadata pointers.
8. Updates bindings only after successful recomputation.

Rollback is modeled as another semantic correction in the reverse direction. Because semantic definitions are immutable and materializations are written to versioned S3 prefixes, rollback is a controlled recomputation and pointer promotion flow rather than a destructive restore.

## Main Architecture Choices

- Aurora PostgreSQL Serverless v2 for metadata because the flow needs transactions, JSONB, and recursive CTEs for lineage traversal.
- EventBridge for decoupled correction events, replay, and auditability.
- SQS plus Lambda for dynamic task orchestration over a propagation-specific DAG.
- Glue or EMR Serverless for batch recomputation.
- Pause/drain/backfill/resume for streaming datasets, with historical backfill from immutable S3 raw archives.
- Tenant isolation through tenant-scoped metadata rows, S3 prefixes, IAM permissions, and concurrency limits.

## Core Tables

- `datasets`
- `semantic_field_definitions`
- `dataset_field_bindings`
- `dataset_lineage`
- `propagation_events`
- `propagation_tasks`

See `docs/document_1_data_models.md` for schemas and rationale.
