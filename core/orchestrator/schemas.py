"""
Orchestrator schemas — M5.5: Memory-Aware Intent & Operations.

Intent taxonomy is defined here as a strongly-typed enum so that:
- The planner produces a constrained intent string validated by Pydantic.
- The validator can enforce semantic invariants deterministically.
- Future intents (e.g., web_search, calendar_read) can be added here
  without rewriting the planner or validator logic.

Memory operations are represented as a constrained string on each
TaskStep, allowing the executor to distinguish semantic operations
without conditional branching on capability names.
"""
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Intent taxonomy
#
# Adding a new intent:
#   1. Add the literal string to IntentType.
#   2. Add validator invariants in validator.py.
#   3. Add examples to the planner prompt.
#   4. Add a test in test_intent_semantics.py.
# ---------------------------------------------------------------------------

IntentType = Literal[
    "knowledge_query",    # General/world knowledge question (no personal facts)
    "memory_query",       # Retrieve user-specific stored information
    "memory_write",       # Store a new user fact, preference, or experience
    "memory_forget",      # Deactivate/delete a stored memory
    "memory_suppress",    # Prevent storing the current interaction
    "tool_action",        # Invoke an external capability (future: web, shell…)
    "workflow",           # Multi-step orchestrated task
    "conversation",       # Purely conversational / no action required
]

# Memory operations are a typed sub-operation on steps whose capability
# is "memory".  Using a separate field keeps the capability name stable
# ("memory") while making the intended operation explicit to the executor
# and validator.
MemoryOperation = Literal[
    "retrieve",   # Query persistent user memories
    "store",      # Persist a new user fact/preference
    "forget",     # Deactivate / soft-delete matching memories
    "suppress",   # Suppress storage for this interaction
    "none",       # Not a memory step (default for non-memory capabilities)
]


class TaskStep(BaseModel):
    id: str
    capability: str
    purpose: str
    depends_on: list[str] = Field(default_factory=list)

    # memory_operation is required when capability == "memory".
    # For all other capabilities it MUST be "none".
    # Enforced deterministically by the validator.
    memory_operation: MemoryOperation = "none"


class TaskPlan(BaseModel):
    goal: str

    # intent is now a typed enum string validated by Pydantic.
    intent: IntentType

    complexity: Literal["simple", "medium", "complex"]
    assumptions: list[str] = Field(default_factory=list)
    requires_memory: bool
    requires_tools: bool
    steps: list[TaskStep]

    @field_validator("assumptions", mode="before")
    @classmethod
    def normalise_assumptions(cls, v: Any) -> Any:
        """
        Coerce common LLM-output sentinel values into an empty list.

        LLMs sometimes produce:
          "assumptions": "none"   — a string meaning "no assumptions"
          "assumptions": null     — JSON null (Python None)
          "assumptions": ""       — empty string

        All three are equivalent to "no assumptions" and are normalised
        to [] before Pydantic enforces the list[str] type.  Valid lists
        (including []) pass through unchanged.
        """
        if v is None:
            return []
        if isinstance(v, str):
            return [] if v.strip().lower() in {"none", "null", "n/a", ""} else [v]
        return v