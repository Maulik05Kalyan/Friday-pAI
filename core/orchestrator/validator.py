"""
Validator — M5.5: Memory-Aware Intent & Operations.

Key changes:
- Capability registry replaces a hardcoded set, making it easy to add
  new capabilities (web.search, calendar, etc.) without touching the
  validator logic.
- Semantic intent invariants are enforced deterministically:
    memory_query  → plan must have a memory retrieve step.
    memory_write  → plan must have a memory store step.
    memory_forget → plan must have a memory forget step.
  These rules cannot be bypassed by the LLM.
- memory_operation consistency:
    knowledge steps must have memory_operation = "none".
    memory steps must have memory_operation != "none".
- Existing structural validations are preserved.

Philosophy: LLM proposes. Runtime validates. Runtime executes.
Invalid plans are rejected here and trigger replanning.
"""
from core.orchestrator.schemas import TaskPlan

# ---------------------------------------------------------------------------
# Capability registry
#
# Extending the system with a new capability:
#   1. Add the capability name here.
#   2. Add a handler in capabilities.py.
#   3. Add planner examples in planner.py.
#   4. Add validator invariants below if the capability has semantic rules.
# ---------------------------------------------------------------------------

AVAILABLE_CAPABILITIES: set[str] = {
    "knowledge",
    "memory",
    # Future: "web", "calendar", "filesystem", "python", "shell", "github", …
}

# Memory operations that are valid for "memory" capability steps.
# "none" is valid only for non-memory capability steps.
VALID_MEMORY_OPERATIONS: set[str] = {"retrieve", "store", "forget", "suppress"}


class PlanValidationError(Exception):
    pass


# ---------------------------------------------------------------------------
# Structural validators (preserved from M5)
# ---------------------------------------------------------------------------

def validate_dependencies(plan: TaskPlan) -> None:
    graph = {step.id: step.depends_on for step in plan.steps}

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise PlanValidationError(
                f"Circular dependency detected involving step '{step_id}'."
            )
        if step_id in visited:
            return
        visiting.add(step_id)
        for dependency in graph[step_id]:
            visit(dependency)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in graph:
        visit(step_id)


# ---------------------------------------------------------------------------
# Semantic intent invariants
# ---------------------------------------------------------------------------

def _plan_has_memory_operation(plan: TaskPlan, operation: str) -> bool:
    """Return True if the plan contains at least one step with the
    given memory_operation on the 'memory' capability."""
    return any(
        step.capability == "memory" and step.memory_operation == operation
        for step in plan.steps
    )


def _validate_intent_invariants(plan: TaskPlan) -> None:
    """
    Enforce semantic invariants between intent and plan steps.

    These rules are deterministic and cannot be bypassed by LLM output.
    If the LLM produces a plan that violates these invariants, the plan
    is rejected and the agent triggers replanning.
    """
    intent = plan.intent

    # memory_query → must have a memory retrieve step
    if intent == "memory_query":
        if not _plan_has_memory_operation(plan, "retrieve"):
            raise PlanValidationError(
                "Intent 'memory_query' requires at least one memory step "
                "with memory_operation='retrieve', but none was found. "
                "User-specific information must be retrieved from memory, "
                "not fabricated from general knowledge."
            )

    # memory_write → must have a memory store step
    elif intent == "memory_write":
        if not _plan_has_memory_operation(plan, "store"):
            raise PlanValidationError(
                "Intent 'memory_write' requires at least one memory step "
                "with memory_operation='store', but none was found."
            )

    # memory_forget → must have a memory forget step
    elif intent == "memory_forget":
        if not _plan_has_memory_operation(plan, "forget"):
            raise PlanValidationError(
                "Intent 'memory_forget' requires at least one memory step "
                "with memory_operation='forget', but none was found."
            )

    # memory_suppress → must have a memory suppress step
    elif intent == "memory_suppress":
        if not _plan_has_memory_operation(plan, "suppress"):
            raise PlanValidationError(
                "Intent 'memory_suppress' requires at least one memory step "
                "with memory_operation='suppress', but none was found."
            )

    # knowledge_query → must NOT require memory retrieval
    # (memory.retrieve is not needed to answer general world-knowledge questions)
    elif intent == "knowledge_query":
        if _plan_has_memory_operation(plan, "retrieve"):
            raise PlanValidationError(
                "Intent 'knowledge_query' must not include a memory retrieval "
                "step. General knowledge questions use the model's world "
                "knowledge, not personal user memory. If the question is "
                "actually about user-specific information, use 'memory_query' "
                "intent instead."
            )


# ---------------------------------------------------------------------------
# memory_operation consistency check
# ---------------------------------------------------------------------------

def _validate_memory_operations(plan: TaskPlan) -> None:
    """
    Enforce memory_operation field consistency:
    - knowledge steps MUST have memory_operation = "none".
    - memory steps MUST have memory_operation in VALID_MEMORY_OPERATIONS.
    """
    for step in plan.steps:
        if step.capability == "memory":
            if step.memory_operation not in VALID_MEMORY_OPERATIONS:
                raise PlanValidationError(
                    f"Step '{step.id}' uses capability 'memory' but has "
                    f"memory_operation='{step.memory_operation}'. "
                    f"Must be one of: {sorted(VALID_MEMORY_OPERATIONS)}."
                )
        else:
            # Non-memory capability steps must not use a memory operation
            if step.memory_operation != "none":
                raise PlanValidationError(
                    f"Step '{step.id}' uses capability '{step.capability}' "
                    f"(not 'memory') but has memory_operation='{step.memory_operation}'. "
                    "Non-memory steps must have memory_operation='none'."
                )


# ---------------------------------------------------------------------------
# Main validation entry point
# ---------------------------------------------------------------------------

def validate_plan(plan: TaskPlan) -> TaskPlan:
    # 1. Plan must have at least one step
    if not plan.steps:
        raise PlanValidationError("Plan must contain at least one step.")

    # 2. Step IDs must be unique
    step_ids = [step.id for step in plan.steps]
    if len(step_ids) != len(set(step_ids)):
        raise PlanValidationError("Step IDs must be unique.")

    # 3. Capabilities must be registered
    for step in plan.steps:
        if step.capability not in AVAILABLE_CAPABILITIES:
            raise PlanValidationError(
                f"Unknown capability: '{step.capability}'. "
                f"Available: {sorted(AVAILABLE_CAPABILITIES)}."
            )

    # 4. Dependencies must reference known steps
    for step in plan.steps:
        for dependency in step.depends_on:
            if dependency not in step_ids:
                raise PlanValidationError(
                    f"Step '{step.id}' depends on unknown step '{dependency}'."
                )

    # 5. External tools not yet available
    if plan.requires_tools:
        raise PlanValidationError("External tools are not currently available.")

    # 6. Cycle detection
    validate_dependencies(plan)

    # 7. memory_operation field consistency
    _validate_memory_operations(plan)

    # 8. Semantic intent invariants (LLM-proof enforcement)
    _validate_intent_invariants(plan)

    return plan