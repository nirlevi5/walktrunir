# Document 1 — Data Models

## Context

The system tracks three kinds of knowledge: *what datasets exist* (dataset registry and current read pointer), *what fields mean* (semantic definitions, versioned), and *what datasets were built against* (bindings to a specific semantic version). A correction does not mutate the shared base data or change the physical schema; it creates a new semantic definition version, marks every dataset that used the old version as stale, and eventually promotes corrected materializations dataset by dataset. The tables below support detecting staleness, traversing the dependency graph, tracking recomputation progress, and serving only validated outputs.

`datasets` is included as a first-class metadata table because the propagation flow reads it to decide how each dataset is recomputed and writes it to promote the newly validated output. Without this table, the design would have no explicit owner for the current materialization pointer that readers use.

---

## Table 1: `datasets`

Dataset registry and serving pointer for each tenant-owned dataset.

| Column | Type | Notes |
|---|---|---|
| `dataset_id` | UUID | Primary key |
| `tenant_id` | UUID | Tenant that owns the dataset |
| `name` | varchar | Human-readable dataset name |
| `pipeline_type` | enum | `batch` \| `streaming`; determines recomputation handler |
| `current_materialization_uri` | text | S3 location currently exposed to readers |
| `consumer_ref` | text (nullable) | Streaming consumer group ID, Lambda event source mapping ARN, or equivalent control-plane reference |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**What it represents:** The authoritative registry of datasets the platform can serve or recompute. It also stores the pointer to the currently committed output for each dataset.

**Why it exists:** Recompute jobs write corrected output to a staging/versioned S3 prefix first. Readers must not see that output until validation succeeds. `current_materialization_uri` is the explicit commit pointer: the Completion Handler advances it only after the task succeeds, and failed tasks leave it unchanged.

**Design decision — metadata pointer vs. overwriting output in place:** A pointer makes promotion and rollback explicit. Overwriting a dataset's current S3 prefix in place risks exposing half-written or unvalidated data and makes rollback a storage recovery problem. With a metadata pointer, prior materializations can remain available until the new one is verified.

---

## Table 2: `semantic_field_definitions`

Stores each version of a field's semantic definition as an immutable row.

| Column | Type | Notes |
|---|---|---|
| `definition_id` | UUID | Primary key |
| `field_name` | varchar | e.g. `event_timestamp` |
| `source_dataset_id` | UUID | The base (or derived) dataset that owns this field |
| `version` | integer | Monotonically increasing per `(field_name, source_dataset_id)` |
| `semantic_type` | varchar | e.g. `iso8601_date`, `free_text_string`, `unix_epoch_ms` |
| `description` | text | Human-readable meaning |
| `time_semantics` | jsonb | For temporal fields: `{ "timezone": "UTC", "precision": "day", "format": "YYYY-MM-DD" }` |
| `nullability_rule` | varchar | How nulls are interpreted (e.g. `event_did_not_occur`, `unknown`) |
| `uniqueness_guarantee` | boolean | Whether values are unique per record |
| `created_at` | timestamptz | |
| `created_by` | varchar | Who authored this version |
| `superseded_by` | UUID (nullable) | FK → `definition_id` of the next version; null if current |

**What it represents:** A permanent record of what a field meant at a point in time. Each correction adds a new row; the semantic contents of old rows are never rewritten.

**Why it exists:** Versioning is the foundation of the whole system. If we updated definitions in place, we'd lose the ability to ask "what version was dataset X computed against?" We need to know the old meaning to (a) identify stale datasets and (b) support rollback by creating a new correction that restores the prior semantics.

**Design decision — `superseded_by` vs. a `is_current` flag:** `superseded_by` encodes the version chain explicitly. A `is_current` boolean requires a mutable current marker that can accidentally disagree with the version chain. `superseded_by` is lifecycle metadata, not the semantic definition itself; it is written once when the next version is created.

---

## Table 3: `dataset_field_bindings`

Records which version of a field's definition each dataset was computed against.

| Column | Type | Notes |
|---|---|---|
| `binding_id` | UUID | Primary key |
| `dataset_id` | UUID | FK → `datasets` |
| `field_name` | varchar | Which field in this dataset references the upstream definition |
| `definition_id` | UUID | FK → `semantic_field_definitions` — the version used at compute time |
| `bound_at` | timestamptz | When this binding was established (last recomputation) |
| `is_stale` | boolean | True if a newer version of this definition exists |
| `tenant_id` | UUID | Denormalized for fast per-tenant staleness queries |

**What it represents:** A snapshot of the semantic contract a dataset was built against. One row per (dataset, upstream field) pair.

**Why it exists:** This is how we detect staleness. When `semantic_field_definitions` gets a new version for `event_timestamp`, we query this table for all datasets where `definition_id` points to any prior version — those are the datasets that need recomputation. Without this table, we'd have no record of what each dataset "knew" when it was built.

**Why `is_stale` is a denormalized boolean rather than a computed join:** At propagation time we need to scan potentially thousands of bindings quickly. A join against `semantic_field_definitions` to check `superseded_by IS NOT NULL` works but is slower. The boolean can be updated in a single `UPDATE ... WHERE definition_id IN (...)` when a new definition is published. It's a deliberate denormalization for read performance.

---

## Table 4: `dataset_lineage`

Represents the directed acyclic graph (DAG) of dataset-to-dataset dependencies.

| Column | Type | Notes |
|---|---|---|
| `lineage_id` | UUID | Primary key |
| `upstream_dataset_id` | UUID | FK → `datasets` — the dataset being depended on |
| `downstream_dataset_id` | UUID | FK → `datasets` — the dataset that depends on it |
| `dependency_type` | enum | `direct_field_ref` \| `full_dataset_ref` |
| `created_at` | timestamptz | |
| `tenant_id` | UUID | The tenant that owns the downstream dataset |

**What it represents:** One row per upstream→downstream edge in the dependency graph. Dataset B depending on Dataset A is one row: `(upstream=A, downstream=B)`.

**Why it exists:** When `event_timestamp` is corrected, the directly affected datasets are those with a binding to the old definition. But their downstream dependents are also affected — transitively. We traverse this table (BFS/DFS from the directly affected nodes) to find the full impact set. Topological sort over this graph gives us the safe recomputation order: recompute upstream before downstream.

**Why store lineage separately from `dataset_field_bindings`:** Bindings answer "what semantic contract did this dataset use?" Lineage answers "what is the data flow structure?" A dataset might depend on an upstream dataset for reasons unrelated to `event_timestamp` (e.g., it joins on `user_id`). Lineage captures the structural dependency regardless of which fields are in play, which is what we need for graph traversal.

---

## Table 5: `propagation_events`

One row per semantic correction — the top-level record for a correction incident.

| Column | Type | Notes |
|---|---|---|
| `event_id` | UUID | Primary key |
| `old_definition_id` | UUID | FK → `semantic_field_definitions` — what it was |
| `new_definition_id` | UUID | FK → `semantic_field_definitions` — what it is now |
| `triggered_by` | varchar | The engineer who made the correction |
| `initiated_at` | timestamptz | |
| `status` | enum | `pending` \| `in_progress` \| `completed` \| `failed` \| `rolled_back` |
| `affected_dataset_count` | integer | Total datasets requiring recomputation (set at event creation) |
| `completed_dataset_count` | integer | Running tally as tasks finish |
| `completed_at` | timestamptz (nullable) | |
| `rollback_event_id` | UUID (nullable) | FK → another `propagation_events` row, if this was rolled back |

**What it represents:** The "incident record" for a semantic correction. It's the anchor that ties together the old definition, the new definition, and all the downstream work.

**Why it exists:** A correction can affect hundreds of datasets and take hours to fully propagate. This table gives operators a single place to check overall progress, trigger a rollback (by creating a new propagation event that swaps old/new back), and audit what happened. `rollback_event_id` creates a linked chain: the rollback event points back to the event it undoes.

---

## Table 6: `propagation_tasks`

One row per dataset per propagation event — the atomic unit of recomputation work.

| Column | Type | Notes |
|---|---|---|
| `task_id` | UUID | Primary key |
| `event_id` | UUID | FK → `propagation_events` |
| `dataset_id` | UUID | FK → `datasets` — which dataset to recompute |
| `tenant_id` | UUID | Denormalized for tenant-scoped queries |
| `pipeline_type` | enum | `batch` \| `streaming` — determines how recomputation is handled |
| `topological_depth` | integer | Depth in the dependency DAG; lower = recompute first |
| `status` | enum | `pending` \| `blocked` \| `in_progress` \| `completed` \| `failed` \| `skipped` |
| `blocked_by_task_ids` | UUID[] | Task IDs that must complete before this one can start |
| `started_at` | timestamptz (nullable) | |
| `completed_at` | timestamptz (nullable) | |
| `attempt_count` | integer | For retry tracking |
| `error_message` | text (nullable) | Populated on failure |
| `recompute_reason` | enum | `direct_semantic_binding` \| `transitive_downstream` |
| `binding_definition_ids_to_update` | UUID[] | Usually `[old_definition_id]` for directly bound datasets; empty for downstream-only recomputations |

**What it represents:** The work queue entry for recomputing one dataset. The full set of tasks for a propagation event is computed up front (topological sort of the affected subgraph) and inserted together when the event is created.

**Why it exists — and why separate from `propagation_events`:** The event is *what changed*; the tasks are *what work needs to happen*. Separating them lets us: (a) retry individual task failures without re-triggering the whole event, (b) observe granular progress (which specific datasets are stuck), and (c) have different handling per `pipeline_type` — a batch task just re-runs a job, a streaming task requires pause/drain/backfill/resume.

**Direct vs. transitive tasks:** Not every affected dataset has a `dataset_field_bindings` row that points directly to the old `event_timestamp` definition. A downstream aggregate might need recomputation because one of its inputs changed, while its own binding rows remain unchanged. `recompute_reason` and `binding_definition_ids_to_update` make that distinction explicit so the Completion Handler updates semantic bindings only when the dataset actually had stale bindings to replace.

**Design decision — `topological_depth` vs. an explicit `blocked_by_task_ids` list:** Both are stored. `topological_depth` is cheap to compute at event creation and sufficient for ordering independent tasks into waves. `blocked_by_task_ids` captures fine-grained dependencies within the same depth level (e.g., two depth-3 datasets where one depends on the other through a non-affected path). Using depth alone risks running tasks too early; the explicit list is the safety check.

---

## How the Tables Connect

```
semantic_field_definitions  (versioned chain via superseded_by)
         │
         │  one definition version can be bound to many datasets
         ▼
dataset_field_bindings  ──────►  datasets  ◄──────  propagation_tasks
         │
         │ identifies direct stale datasets      ▲
         │                                      │ one event spawns one task
         ▼                                      │ per affected dataset
propagation_events  ───────────────────────────┘
         │
         │ traversal order determined by
         ▼
dataset_lineage  (the DAG: upstream_id → downstream_id)
```

When `event_timestamp`'s definition is corrected:
1. A new row is inserted into `semantic_field_definitions` (the correction).
2. The old row's `superseded_by` is set to the new `definition_id`.
3. All matching rows in `dataset_field_bindings` have `is_stale` set to `true`.
4. A `propagation_events` row is created.
5. The lineage DAG is traversed to find all affected datasets (direct + transitive).
6. The traversal joins `datasets` to copy each affected dataset's `pipeline_type` into its task.
7. `propagation_tasks` rows are inserted with computed `topological_depth` and `blocked_by_task_ids`.
8. Tasks execute in topological order; each successful completion promotes `datasets.current_materialization_uri` to the validated output and increments `propagation_events.completed_dataset_count`. For directly bound datasets, the matching `dataset_field_bindings` rows are updated to the new definition with `is_stale = false`; downstream-only tasks are marked complete without inventing a binding they did not have.
