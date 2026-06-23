# Document 2 — AWS Architecture

## Context

This document describes the AWS infrastructure that supports the semantic propagation system defined in Document 1. The goal is not a generic data platform architecture — it is the specific set of services needed to:

1. Store and version semantic field definitions
2. Detect when a definition changes and trigger downstream work
3. Traverse the lineage DAG and create an ordered task queue
4. Execute recomputation across batch and streaming pipelines in topological order
5. Isolate work per tenant and support rollback

The six data model tables from Document 1 (`datasets`, `semantic_field_definitions`, `dataset_field_bindings`, `dataset_lineage`, `propagation_events`, `propagation_tasks`) are the metadata source of truth throughout. Every architectural decision maps back to operations on those tables.

---

## Architecture Overview

```
Engineer
   │
   │  POST /definitions/{field_name}/correct
   ▼
API Gateway
   │
   ▼
Lambda: Metadata Writer
   │  ┌─────────────────────────────────────────────────────────┐
   ├──► Aurora PostgreSQL (Serverless v2)                       │
   │  │  semantic_field_definitions  (insert new version row)   │
   │  │  semantic_field_definitions  (set superseded_by)        │
   │  │  dataset_field_bindings      (bulk set is_stale=true)   │
   │  └─────────────────────────────────────────────────────────┘
   │
   │  publish DefinitionCorrected event
   ▼
EventBridge (custom bus)
   │
   ▼
Lambda: DAG Traversal
   │  ┌──────────────────────────────────────────────────────────┐
   ├──► Aurora PostgreSQL                                        │
   │  │  dataset_lineage       (BFS / recursive CTE traversal)  │
   │  │  propagation_events    (insert event row)               │
   │  │  propagation_tasks     (bulk insert all task rows)      │
   │  └──────────────────────────────────────────────────────────┘
   │
   │  enqueue depth-0 tasks only
   ▼
SQS: Batch Task Queue          SQS: Streaming Task Queue
   │                                   │
   ▼                                   ▼
Lambda: Batch Task Starter     Lambda: Streaming Task Handler
   │                                   │
   ▼                                   ▼
Glue / EMR Serverless          Streaming Control Plane
(recompute dataset)            (pause → drain → backfill → resume)
   │                                   │
   └──────────────┬────────────────────┘
                  │  on task completion
                  ▼
         Lambda: Completion Handler
            │  ┌──────────────────────────────────────────────────┐
            ├──► Aurora PostgreSQL                                │
            │  │  propagation_tasks    (mark completed)           │
            │  │  datasets             (promote read pointer)      │
            │  │  dataset_field_bindings (update direct stale rows)│
            │  │  propagation_events   (increment completed count)│
            │  └──────────────────────────────────────────────────┘
            │
            │  check blocked_by_task_ids — release unblocked tasks
            │
            └──► SQS (enqueue newly unblocked tasks)
```

---

## Component Breakdown

### Aurora PostgreSQL (Serverless v2)

**Purpose:** Hosts all six metadata tables. Acts as the single source of truth for the dataset registry, definitions, bindings, lineage, and propagation state.

**Why Aurora PostgreSQL and not DynamoDB or plain RDS:**
- The bulk staleness sweep (`UPDATE dataset_field_bindings SET is_stale=true WHERE definition_id IN (...)`) needs to be atomic with the definition insert and the `superseded_by` update. PostgreSQL transactions give this for free; DynamoDB transactions are capped at 100 items.
- The Completion Handler must atomically promote `datasets.current_materialization_uri`, update direct stale bindings, mark the task complete, and advance event progress. A single relational transaction prevents readers from seeing a new pointer while the metadata still says the dataset is stale, or vice versa.
- `time_semantics` is stored as JSONB. PostgreSQL queries it natively (e.g., `WHERE time_semantics->>'timezone' = 'UTC'`); DynamoDB would require a separate attribute per subfield or a serialized blob.
- `dataset_lineage` traversal is a recursive query. PostgreSQL recursive CTEs (`WITH RECURSIVE`) express this in a single query. In DynamoDB you'd implement BFS in application code with multiple round trips.
- Serverless v2 scales ACUs (Aurora Capacity Units) to zero when idle, which matters for a platform where propagation bursts are infrequent.

**Configuration:**
- One writer instance + one read replica; DAG traversal queries and status-check reads go to the replica.
- Deployed in a private VPC subnet. Lambda functions connect via VPC configuration, not public internet.
- Secrets Manager stores connection credentials, rotated automatically.

**Alternatives considered:** Amazon RDS for PostgreSQL (same SQL, but no serverless scaling), DynamoDB (rejected — see above), Neptune (graph-native, but overkill for a DAG that fits comfortably in a relational table and adds operational complexity).

---

### S3: Raw Archive and Versioned Materializations

**Purpose:** Stores immutable raw events and materialized dataset outputs. Recompute jobs never overwrite the currently served output in place; they write to a propagation-specific prefix and the metadata layer promotes that prefix only after validation.

**Layout:**
- Raw archive: `s3://data-platform-raw/{tenant_id}/...`
- Current materializations: referenced by `datasets.current_materialization_uri`
- Propagation staging outputs: `s3://data-platform/{tenant_id}/datasets/{dataset_id}/propagations/{event_id}/`

**Why versioned prefixes instead of relying only on S3 bucket versioning:**
S3 bucket versioning is useful as a guardrail against accidental deletes, but it is awkward as the primary serving mechanism because readers need a stable, intentional pointer to a coherent dataset snapshot. A metadata pointer (`current_materialization_uri`) makes promotion and rollback explicit: readers keep seeing the previous output until the Completion Handler promotes the new prefix.

---

### API Gateway + Lambda: Metadata Writer

**Purpose:** The entry point for an engineer submitting a definition correction. Performs all database writes for the correction itself and publishes the triggering event.

**Why a single Lambda for all three writes:**
The three writes — insert new definition row, set `superseded_by` on the old row, bulk-update `dataset_field_bindings.is_stale` — must be atomic. Splitting them across separate services introduces a window where the new definition exists but the old row still has a null `superseded_by`, causing inconsistent staleness detection. A single Lambda wraps them in one database transaction.

The EventBridge publish happens after the transaction commits. If it fails, the Lambda retries (API Gateway timeout is set to allow this). The DB state is already consistent; the event is the only thing that can be lost, and retrying it is safe because the Metadata Writer is idempotent against a definition_id that already exists.

**Request validation:**
- API Gateway validates the request body schema (field name, new semantic type, description, time_semantics) before the Lambda is invoked.
- Lambda confirms `definition_id` uniqueness and that the field_name exists before writing.

---

### EventBridge (Custom Bus)

**Purpose:** Decouples the definition correction from the propagation work. The Metadata Writer publishes one event; EventBridge routes it to one or more consumers without the writer knowing what they are.

**Event schema (`DefinitionCorrected`):**
```json
{
  "source": "walktru.semantic-catalog",
  "detail-type": "DefinitionCorrected",
  "detail": {
    "field_name": "event_timestamp",
    "old_definition_id": "<uuid>",
    "new_definition_id": "<uuid>",
    "triggered_by": "engineer@company.com",
    "initiated_at": "2026-06-23T10:00:00Z"
  }
}
```

**Why EventBridge and not SNS or direct Lambda invocation:**
- EventBridge rules let you add new consumers (audit log, Slack notifier, metrics publisher) without touching the Metadata Writer.
- Event replay is built in: if the DAG Traversal Lambda fails, you can replay the event from the EventBridge archive without re-running the definition correction.
- SNS would work but has weaker filtering and no replay.

**Rules configured:**
- `DefinitionCorrected` → DAG Traversal Lambda (always)
- `DefinitionCorrected` → CloudWatch Logs (always, for audit trail)

---

### Lambda: DAG Traversal

**Purpose:** Responds to the `DefinitionCorrected` event. Creates the propagation plan: the `propagation_events` row and all `propagation_tasks` rows with topological ordering.

**Algorithm:**
1. Query `dataset_field_bindings` for all datasets bound to `old_definition_id` — these are the directly affected datasets (depth 0).
2. From those datasets, BFS over `dataset_lineage` to find all transitive downstream dependents. Each hop increments the depth counter.
3. Topological sort the full affected subgraph. For each node, compute `blocked_by_task_ids` as the subset of its direct upstream task IDs that are in the affected set.
4. Insert `propagation_events` row with `affected_dataset_count` set.
5. Join `datasets` to copy `pipeline_type` into each task, so batch and streaming work can be routed without another lookup at queue time.
6. Bulk-insert all `propagation_tasks` rows (one per affected dataset, with `topological_depth` and `blocked_by_task_ids`).
7. Enqueue only the tasks with `topological_depth = 0` to SQS.

**Why compute the full task set up front instead of dynamically:**
Inserting all tasks at creation time means the full scope is visible immediately. Operators can query `propagation_tasks` to see what work is outstanding before any task runs. Dynamic task creation (spawn children on completion) would make progress opaque until late in the propagation.

**BFS implementation:**
A PostgreSQL recursive CTE handles graphs that fit in memory. For very large graphs (>10k nodes), the Lambda paginates the BFS in application code using a frontier set stored in ElastiCache (Redis) to avoid reloading visited nodes on each iteration.

---

### SQS: Batch Task Queue and Streaming Task Queue

**Purpose:** Durable task queues for batch and streaming recomputation work, kept separate because the two pipeline types have entirely different handlers, timeouts, and error characteristics.

**Configuration per queue:**
- Visibility timeout: 5 minutes for batch start messages, 30 minutes for streaming control messages
- Dead-letter queue (DLQ): after 3 failed attempts to start/control the task, message moves to DLQ and triggers a CloudWatch alarm
- Message attributes: `tenant_id`, `task_id`, `event_id`, `topological_depth`

**Tenant isolation:**
A shared queue is used initially with `tenant_id` as a message attribute. Lambda reserved concurrency is configured per tenant (using Lambda function-level or per-alias concurrency limits with a dispatcher pattern) to prevent one tenant's large propagation from starving another's. If a tenant requires hard SLA guarantees or billing-level isolation, the queue is promoted to a per-tenant queue — the Completion Handler already knows which queue to use via the tenant record.

**Why SQS and not Step Functions for task orchestration:**
Step Functions would require the dependency graph to be expressed in the state machine definition at creation time, but the graph is dynamic — it varies per correction and per tenant. Step Functions also charges per state transition; a propagation touching 5,000 datasets with multiple state transitions per task would cost meaningfully more than SQS at $0.40 per million messages. Most importantly, Step Functions Standard Workflows are not designed for "wait until N dynamic tasks complete, then release M others" — that conditional fan-out is exactly what the Completion Handler implements with a database check.

---

### Lambda: Batch Task Starter

**Purpose:** Receives a batch task from SQS and starts the appropriate Glue or EMR Serverless job to recompute the dataset. The long-running job lifecycle is tracked in Aurora and completed by EventBridge job-state events, not by keeping the SQS message invisible for the whole recomputation.

**Flow:**
1. Read `task_id` from SQS message.
2. Update `propagation_tasks.status` to `in_progress`, set `started_at`.
3. Start a Glue job (or EMR Serverless job run) parameterized with `dataset_id`, `new_definition_id`, and the S3 output path.
4. Store the external Glue/EMR job run ID on the `propagation_tasks` row or a small task-run table.
5. Acknowledge the SQS message once the job is started successfully.
6. Glue/EMR publishes job-state events to EventBridge. On job success, invoke the Completion Handler. On job failure, increment `attempt_count` and either enqueue a fresh start message or mark the task `failed` after the retry threshold.

**Glue vs EMR Serverless:**
Glue is the default — no cluster management, pay-per-DPU-second, native AWS catalog integration. EMR Serverless is chosen when the recomputation logic is already in PySpark and the team owns the job code. Both publish completion events to EventBridge, making the completion handling identical.

---

### Lambda: Streaming Task Handler

**Purpose:** Pauses, drains, updates, and resumes a streaming pipeline consumer for a given dataset. This is the most operationally sensitive path in the system.

**Steps:**
1. Identify the streaming consumer for `dataset_id` (stored in the `datasets` table as a consumer group ID or Lambda event source mapping ARN).
2. **Pause**: disable the Lambda event source mapping (or suspend the MSK consumer group) to stop new records from being processed.
3. **Drain**: wait until the in-flight records batch is fully processed and committed (monitored via CloudWatch metric `IteratorAgeMilliseconds` dropping to 0, or MSK consumer lag reaching 0).
4. **Update**: push the new semantic definition config to the consumer (e.g., update a Parameter Store value that the consumer reads at startup, or update a Glue Schema Registry schema version).
5. **Historical backfill**: launch a bounded backfill job from the immutable raw-event archive in S3, not from the live stream. Kinesis/MSK retention may not cover a year of history, and replaying an old checkpoint through the production consumer can duplicate side effects.
6. **Resume live processing**: re-enable the event source mapping from the drained checkpoint with the corrected semantic interpretation. New events accumulate during the pause and are processed once the consumer resumes.
7. Invoke the Completion Handler after the historical backfill has produced the corrected materialization and the live consumer is running on the new config.

**State storage during pause/drain:**
A DynamoDB table (separate from the Aurora metadata store) holds the streaming task's interim state (`consumer_id`, `pause_timestamp`, `drain_confirmed_at`, `resume_checkpoint`, `backfill_job_id`). This is a lightweight control-plane record, not semantic metadata — it doesn't need the relational power of Aurora.

**Kinesis vs MSK:**
Kinesis is simpler to pause (disable event source mapping in Lambda). MSK gives more control over consumer group offsets and is preferred when the streaming pipeline is already Kafka-based. The Streaming Task Handler abstracts the difference behind a consumer-type field on the `datasets` record.

---

### Lambda: Completion Handler

**Purpose:** Called by both the Batch and Streaming Task Handlers on task success. Updates the database and releases the next wave of tasks.

**Steps:**
1. In a single Aurora transaction:
   - Set `propagation_tasks.status = 'completed'`, `completed_at = now()` for the finished task.
   - Promote the validated propagation output by updating `datasets.current_materialization_uri`.
   - For directly bound datasets only: update matching `dataset_field_bindings` rows from the old definition to the new version, set `is_stale = false`, `bound_at = now()`.
   - Increment `propagation_events.completed_dataset_count`.
   - If `completed_dataset_count = affected_dataset_count`, set `propagation_events.status = 'completed'` and `completed_at`.
2. Query `propagation_tasks` for any tasks whose `blocked_by_task_ids` are now all `completed` → these are newly unblocked.
3. Enqueue unblocked tasks to the appropriate SQS queue (batch or streaming).

**Why atomic update of bindings in the Completion Handler and not in the compute job itself:**
The compute job (Glue, EMR, consumer) rewrites data but shouldn't own the metadata contract. Keeping the binding update in the Completion Handler means the metadata layer has a single writer, and the transition from `is_stale=true` to `is_stale=false` for directly bound datasets is instant and consistent — not spread across many concurrent job processes.

---

## Tenant Isolation

Isolation is enforced at three layers:

**Data layer:** Dataset-level rows (`datasets`, `dataset_field_bindings`, `dataset_lineage`, `propagation_tasks`) carry `tenant_id` directly. Definition rows are scoped through `source_dataset_id`, and `propagation_events` are global incident records whose tenant-visible details come from the tenant-scoped tasks. Aurora row-level security policies (using `SET app.current_tenant_id` at connection time, applied via a Lambda middleware wrapper) prevent cross-tenant reads at the database level.

**Compute layer:** Glue jobs and EMR runs are parameterized with `tenant_id` and write to tenant-scoped S3 prefixes (`s3://data-platform/{tenant_id}/datasets/{dataset_id}/`). IAM execution roles for Glue are scoped to `s3:GetObject` and `s3:PutObject` on the tenant's prefix only.

**Queue layer:** SQS messages carry `tenant_id` as a message attribute. Lambda reserved concurrency limits (applied per-function with a routing dispatcher) prevent one tenant's backlog from consuming all available Lambda capacity. A concurrency budget (e.g., 40 concurrent executions per tenant) is configurable and stored in Systems Manager Parameter Store.

---

## Rollback

The architecture supports rollback without any special-casing in the task queue machinery. Rollback is simply a reverse propagation event. Materialized outputs are written to versioned S3 prefixes and promoted by metadata pointer after verification, so prior outputs remain available during rollback.

**To roll back a correction:**
1. Call the Metadata Writer with the correction reversed: `old_definition_id` = the (now current) corrected version, `new_definition_id` = the prior version. The Metadata Writer sets `superseded_by` on the corrected version, marks bindings stale, and creates a new `propagation_events` row with `rollback_event_id` pointing to the original event.
2. The same EventBridge → DAG Traversal → SQS → Task Handler → Completion Handler pipeline runs.
3. Datasets recompute against the prior definition version.

**Why this works:** `semantic_field_definitions` rows are immutable in their semantic contents. The prior version's row still exists with its full definition intact, and prior materialized outputs are retained in versioned S3 locations until the propagation is verified. Rollback is therefore a metadata-driven recomputation and pointer promotion, not an emergency restore from backup.

**Partial rollback** (rolling back a single tenant without affecting others) is supported by scoping the `UPDATE dataset_field_bindings SET is_stale=true` in the Metadata Writer to a specific `tenant_id`, and creating `propagation_tasks` only for that tenant's affected datasets.

---

## Observability

**CloudWatch Metrics (custom, published by each Lambda):**
- `PropagationTasksCompleted` (per `event_id`, per `tenant_id`)
- `PropagationTasksFailed` (per `event_id`, per `tenant_id`)
- `PropagationLagSeconds` (time from `propagation_events.initiated_at` to last task completion)
- `StreamingDrainDurationSeconds` (to detect stuck drains)

**CloudWatch Alarms:**
- DLQ message count > 0 → PagerDuty/SNS notification (stuck or repeatedly-failing task)
- `PropagationLagSeconds` > threshold → warning that propagation is running behind SLA
- Aurora writer CPU > 80% → scale up alert

**Status API:**
An API Gateway endpoint (`GET /propagations/{event_id}`) queries `propagation_events` and `propagation_tasks` and returns overall progress, per-dataset task status, and any error messages. This is what the triggering engineer uses to monitor their correction in real time.

**Audit trail:**
All `DefinitionCorrected` EventBridge events are archived to CloudWatch Logs and optionally to S3 via Firehose. Combined with the immutable `semantic_field_definitions` table, this gives a full audit log of who changed what and when, queryable without touching the operational database.

---

## How the Architecture Maps to the Data Model

| Data Model Table | AWS Service(s) That Write It | AWS Service(s) That Read It |
|---|---|---|
| `datasets` | External dataset registration, Completion Handler (read pointer promotion) | DAG Traversal Lambda, Task Handlers, query layer, Status API |
| `semantic_field_definitions` | Metadata Writer Lambda | DAG Traversal Lambda, Status API |
| `dataset_field_bindings` | Metadata Writer Lambda (stale sweep), Completion Handler (bind update) | DAG Traversal Lambda, Status API |
| `dataset_lineage` | External pipeline registration (not part of this flow) | DAG Traversal Lambda |
| `propagation_events` | DAG Traversal Lambda, Completion Handler | Status API, CloudWatch dashboards |
| `propagation_tasks` | DAG Traversal Lambda | Completion Handler, Task Handlers, Status API |

---

## Key Design Decisions Summary

| Decision | Choice Made | Main Alternative | Why |
|---|---|---|---|
| Metadata store | Aurora PostgreSQL Serverless v2 | DynamoDB | Atomic multi-table transactions, JSONB, recursive CTEs for BFS |
| Event routing | EventBridge custom bus | SNS, direct Lambda invoke | Decoupling, event replay, easy consumer fan-out |
| Task orchestration | SQS + Lambda | Step Functions | Dynamic graph, cost at scale, Step Functions can't natively fan-out on dynamic task completion |
| Batch recomputation | Glue / EMR Serverless | Self-managed Spark on EC2 | No cluster management, pay-per-use, EventBridge completion events |
| Streaming control | Pause/drain live consumer + S3 historical backfill | Rewind production stream checkpoint | Avoids relying on stream retention and avoids duplicating production side effects |
| Tenant isolation | Shared queue + per-tenant concurrency limits | Per-tenant SQS queues | Lower infra overhead initially; per-tenant queues are an upgrade path |
| Task set creation | Up front at event creation | Dynamically on task completion | Full scope visible immediately; operators can audit before execution begins |
