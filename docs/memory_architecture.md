# M5 — Persistent Memory + Context Architecture Documentation

## Overview

Milestone 5 (M5) introduces a production-ready, modular persistent memory subsystem for the Personal AI Assistant.
The subsystem enables long-term retention of user preferences, project facts, interaction episodes, and reusable procedures, without compromising user privacy or breaking the existing orchestrator architecture (`Planner → Validator → Executor → Observe → Replan`).

---

## 1. High-Level Architecture

The memory subsystem is decoupled from both the Planner and the underlying vector database implementation through clean interfaces.

```
USER INTERACTION
       │
       ▼
 ┌───────────────┐
 │ ContextBuilder│ ◄─── Retrieves top-k relevant memories from Vector DB
 └───────┬───────┘
         │ (Augmented prompt: Current Request + Relevant Memories)
         ▼
 ┌───────────────┐
 │    Planner    │ ─── Determines intent, dependencies, and requires_memory
 └───────┬───────┘
         │ (TaskPlan)
         ▼
 ┌───────────────┐
 │   Validator   │ ─── Deterministically validates capabilities & step DAG
 └───────┬───────┘
         │
         ▼
 ┌───────────────┐
 │   Executor    │ ─── Executes steps according to topological dependencies
 └───────┬───────┘
         │
         ▼
 ┌───────────────┐
 │ Observe/Replan│ ─── On failure, replans up to MAX_REPLANS attempts
 └───────┬───────┘
         │ (On success)
         ▼
 ┌───────────────┐
 │ MemoryManager │ ─── Privacy Check ➔ Extraction ➔ Dedup ➔ Embed ➔ Store
 └───────────────┘
```

---

## 2. Memory Categories (Types)

The system organizes memories into four distinct logical categories:

1. **Working Memory (`working`)**:
   - Short-lived, task-scoped context (current execution state, intermediate observations).
   - Never automatically persisted as permanent vector memory.

2. **Episodic Memory (`episodic`)**:
   - Records of past user interactions, completed tasks, major architectural decisions, and workflow outcomes.

3. **Semantic Memory (`semantic`)**:
   - Long-lived, stable facts and user preferences (e.g., preferred languages, editor settings, development workstation specs).

4. **Procedural Memory (`procedural`)**:
   - Reusable instructions, workflows, and procedures (e.g., "Always execute pytest before submitting commits").

---

## 3. Data Model

Every memory is structured and validated using Pydantic:

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `str` (UUID) | Unique memory identifier |
| `content` | `str` | Textual content of the memory |
| `memory_type` | `MemoryType` | Enum: `working`, `episodic`, `semantic`, `procedural` |
| `embedding` | `list[float]` | Vector representation matching model dimension |
| `metadata` | `dict[str, Any]` | Sanitized structured key-value attributes |
| `source` | `str` | Provenance source (e.g., `user_message`, `explicit_command`) |
| `source_reference` | `str \| None` | Traceability reference (e.g., conversation or message ID) |
| `created_at` | `datetime` (UTC) | Creation timestamp |
| `updated_at` | `datetime` (UTC) | Last content modification timestamp |
| `last_accessed_at` | `datetime` (UTC) | Last retrieval / reinforcement timestamp |
| `access_count` | `int` | Number of times recalled / reinforced |
| `confidence` | `float` [0.0, 1.0] | Extraction confidence score |
| `importance` | `float` [0.0, 1.0] | Semantic priority / longevity weight |
| `scope` | `MemoryScope` | Enum: `global`, `user`, `conversation`, `project`, `task` |
| `user_id` | `str \| None` | Optional user ownership |
| `project_id` | `str \| None` | Optional project association |
| `conversation_id` | `str \| None`| Optional conversation session |
| `tags` | `list[str]` | Categorization keywords |
| `active` | `bool` | Status flag (`False` indicates soft-deleted or forgotten) |

---

## 4. Vector Database & Storage

- **Default Implementation**: **Qdrant** running locally via Docker on ports `6333` (REST) and `6334` (gRPC).
- **Persistent Volume**: `./qdrant_storage:/qdrant/storage:z` persists collections and indexes across application restarts.
- **Abstraction**: `VectorStore` interface provides:
  - `add(memory)`
  - `update(memory)`
  - `delete(memory_id, hard_delete)`
  - `get(memory_id)`
  - `search(query_vector, top_k, filter, min_similarity)`
  - `list(filter, limit, offset)`
  - `count(filter)`
- **Fallback**: `InMemoryVectorStore` provides identical functionality in Python memory for fast unit tests or when the external vector database is offline.

---

## 5. Embedding Provider

- **Default Model**: `all-MiniLM-L6-v2` via `sentence-transformers`.
- **Dimensions**: 384 dimensions with cosine similarity normalization.
- **Local & Offline**: Runs 100% locally on CPU/GPU without external API dependency.
- **Abstraction**: `EmbeddingProvider` with `SentenceTransformerEmbeddingProvider` and deterministic `DeterministicMockEmbeddingProvider` for lightning-fast testing.

---

## 6. Deduplication & Reinforcement

When new memory candidates are proposed:
1. The memory manager computes the candidate embedding.
2. It queries existing active memories in the same scope with a configurable deduplication threshold (`MEMORY_DEDUP_THRESHOLD=0.85`).
3. If an existing memory is semantically equivalent:
   - The existing memory is **reinforced** instead of creating a duplicate.
   - `access_count` is incremented.
   - `last_accessed_at` and `updated_at` are refreshed.
   - If the new content is more detailed, the content is updated while preserving original memory ID and provenance.

---

## 7. Multi-Factor Deterministic Ranking & Decay

Raw vector similarity alone is insufficient for effective assistant memory. The retrieval engine applies a deterministic multi-factor scoring formula:

$$\text{Relevance} = w_{\text{sim}} \cdot \text{Sim} + w_{\text{imp}} \cdot \text{Imp} + w_{\text{dec}} \cdot \text{Decay} + w_{\text{acc}} \cdot \text{Access} + w_{\text{scope}} \cdot \text{Scope}$$

- **Decay Function**: Half-life decay ($T_{1/2} = 30\text{ days}$) based on age since last access.
- **Importance Shield**: High importance ($1.0$) dampens decay rate; low importance memories fade gracefully.
- **Access Boost**: Logarithmic access frequency boost ($\min(0.3, 0.1 \cdot \ln(1 + \text{count}))$).
- **Decayed memories are NEVER automatically deleted**; they simply rank lower in retrieval unless explicitly reinforced or deleted.

---

## 8. Privacy, Security & Explicit Forget

- **Secret Scrubbing**: Automatic regex detection and rejection/redaction for API keys (OpenAI, GitHub, AWS, Bearer tokens), private keys, and passwords.
- **User Control Commands**:
  - `Remember that [fact]`: Explicitly creates a high-confidence memory.
  - `Forget that [fact]`: Performs semantic search and deactivates matching memories.
  - `Don't remember this`: Suppresses memory extraction for the current message.
  - `What do you remember about [topic]`: Queries memory records.
- **Kill-Switch**: `MEMORY_ENABLED=false` disables all memory writes and retrievals.

---

## 9. Planner & Orchestrator Integration

- **`requires_memory` Field**:
  - The planner evaluates whether persistent memory is required or beneficial.
  - Examples:
    - `"What is gradient descent?"` ➔ `requires_memory: false`
    - `"What was the architecture decision we made for my AI assistant?"` ➔ `requires_memory: true`
    - `"Continue the project we discussed yesterday."` ➔ `requires_memory: true`
- **Context Builder Rules**:
  - Current user message always takes precedence over retrieved memories.
  - Context is cleanly formatted under `### RELEVANT PERSISTENT MEMORIES` and `### CURRENT USER REQUEST`.
  - The planner never receives vendor-specific vector database constructs.

---

## 10. Local Setup & Docker Instructions

### 1. Start Qdrant Vector Database
```bash
docker compose up -d
```

### 2. Configure Environment (`.env`)
```bash
cp .env.example .env
```

### 3. Run Tests
```bash
.venv/bin/pytest -v
```

### 4. Interactive CLI Run
```bash
python main.py
```
