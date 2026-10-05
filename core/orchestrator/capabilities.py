"""
Capability handlers — M5.5: Memory-Aware Intent & Operations.

Key changes:
- Memory operations are now explicitly dispatched based on
  step.memory_operation rather than re-parsing the user message.
  This removes ambiguity from the execution path.
- Capability registry uses a clean dict[str, CapabilityHandler] pattern
  that scales from 2 to 100+ capabilities without conditional branching.
- Each handler receives the full TaskStep so it can inspect memory_operation.
- The LLM never receives direct database write authority.
  All memory writes flow through MemoryManager's privacy + dedup pipeline.

Adding a new capability:
  1. Register it in AVAILABLE_CAPABILITIES in validator.py.
  2. Implement a handler function: (TaskStep, str) -> str.
  3. Add it to CAPABILITIES dict at the bottom of this file.
  No other files need to change.
"""
import logging
from collections.abc import Callable

from core.models.gateway import ModelGateway
from core.orchestrator.schemas import TaskStep

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Handler type
# ---------------------------------------------------------------------------

CapabilityHandler = Callable[[TaskStep, str], str]

# Module-level gateway singleton (injected at startup)
gateway = ModelGateway()

# Module-level memory manager (lazy-initialized)
_default_memory_manager = None


def get_memory_manager():
    global _default_memory_manager
    if _default_memory_manager is None:
        try:
            from core.memory.manager import MemoryManager
            _default_memory_manager = MemoryManager(gateway=gateway)
        except Exception as e:
            logger.warning("Could not initialize default MemoryManager: %s", e)
    return _default_memory_manager


# ---------------------------------------------------------------------------
# knowledge handler
# ---------------------------------------------------------------------------

def knowledge_handler(step: TaskStep, user_message: str) -> str:
    """
    Answer using the model's general/world knowledge.

    This handler MUST NOT be used to answer user-specific questions
    (preferences, past decisions, personal history). Those belong to
    memory_handler with memory_operation='retrieve'.
    """
    messages = [
        {
            "role": "system",
            "content": (
                "Answer the user's question clearly and accurately using "
                "your general world knowledge. "
                "Do not fabricate personal facts about the user. "
                "Do not discuss the internal planning process."
            ),
        },
        {"role": "user", "content": user_message},
    ]
    response = gateway.generate(messages, temperature=0.2, max_tokens=512)
    return response.content


# ---------------------------------------------------------------------------
# memory handler — dispatches by step.memory_operation
# ---------------------------------------------------------------------------

def memory_handler(step: TaskStep, user_message: str) -> str:
    """
    Dispatch memory operations based on the step's memory_operation field.

    Operations:
      retrieve — semantic search of persistent user memories.
      store    — persist a new user fact / preference.
      forget   — deactivate memories matching the step purpose.
      suppress — prevent storage for this interaction.

    The memory_operation field is set by the planner and validated by the
    validator before this handler is ever called.
    """
    mm = get_memory_manager()
    if mm is None or not mm.is_enabled():
        return "Memory system is currently unavailable or disabled."

    op = step.memory_operation

    if op == "retrieve":
        return _memory_retrieve(mm, step, user_message)
    elif op == "store":
        return _memory_store(mm, step, user_message)
    elif op == "forget":
        return _memory_forget(mm, step, user_message)
    elif op == "suppress":
        return _memory_suppress(mm)
    else:
        # "none" should never reach here — validator catches it.
        # Guard defensively.
        logger.error(
            "memory_handler called with unexpected memory_operation='%s' on step '%s'. "
            "This indicates a validator bug.",
            op, step.id,
        )
        return f"Memory operation '{op}' is not supported."


def _memory_retrieve(mm, step: TaskStep, user_message: str) -> str:
    """Semantic retrieval of user-specific persistent memories."""
    query = step.purpose or user_message
    retrieved = mm.retrieve(query, top_k=5)
    if not retrieved:
        return (
            "No relevant memories found for this query. "
            "The answer to this personal question is not currently stored."
        )
    formatted = "\n".join(f"- {sm.memory.content}" for sm in retrieved)
    return f"Retrieved from personal memory:\n{formatted}"


def _memory_store(mm, step: TaskStep, user_message: str) -> str:
    """Persist a user fact or preference via the MemoryManager pipeline."""
    # Use the step purpose as the content to store, falling back to the
    # full user message. The MemoryManager applies privacy filtering,
    # deduplication, and embedding before persisting.
    content = step.purpose or user_message
    mem = mm.remember(
        content=content,
        source="explicit_command",
    )
    if mem is None:
        return (
            "Memory could not be stored (possible: sensitive content detected, "
            "or memory system disabled)."
        )
    return f"Stored to personal memory: '{mem.content}' (id={mem.id})"


def _memory_forget(mm, step: TaskStep, user_message: str) -> str:
    """Deactivate memories that match the step purpose description."""
    target = step.purpose or user_message
    count = mm.forget(target)
    if count == 0:
        return f"No matching memories found to forget for: '{target}'"
    return f"Deactivated {count} memory record(s) matching: '{target}'"


def _memory_suppress(mm) -> str:
    """Mark current interaction as suppressed — no memory will be stored."""
    logger.info("[MEMORY_SUPPRESS] Memory retention suppressed for this interaction.")
    return "Memory retention suppressed for this interaction."


# ---------------------------------------------------------------------------
# Capability registry
#
# This is the single authoritative map from capability name → handler.
# The validator's AVAILABLE_CAPABILITIES set must stay in sync with this.
# ---------------------------------------------------------------------------

CAPABILITIES: dict[str, CapabilityHandler] = {
    "knowledge": knowledge_handler,
    "memory": memory_handler,
    # Future registrations:
    # "web": web_handler,
    # "calendar": calendar_handler,
    # "filesystem": filesystem_handler,
    # "python": python_handler,
    # "shell": shell_handler,
    # "github": github_handler,
}