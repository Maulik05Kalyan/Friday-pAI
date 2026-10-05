"""
ContextBuilder — M5.5: Provenance-aware context assembly.

Key changes:
- PreparedContext now has a typed, structured source model so each piece
  of context is clearly labeled with its provenance.
- ContextSource enum allows the planner to understand where information
  came from (user_memory, system_info, tool_result, etc.).
- to_planner_prompt() renders context blocks with clear section headers
  that the planner instructions reference explicitly.
- The memory block includes source labels so the planner (and eventually
  a reasoning model) can distinguish personal memory from world knowledge.
- Adding a new context source (e.g., web_results, calendar_events) only
  requires adding it to ContextSource and adding a block to to_planner_prompt().

The rendering contract:
  ### USER MEMORY
  [Retrieved from personal persistent memory. Use this for user-specific facts.]
  1. [Semantic Memory - Scope: user] <content>

  ### CURRENT USER REQUEST
  <user message>
"""
from dataclasses import dataclass, field
import logging
from typing import Any

from core.memory.manager import MemoryManager
from core.memory.schemas import ScoredMemory

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provenance types
# ---------------------------------------------------------------------------

class ContextSource:
    """
    String constants for context source labels.

    Using a class with string constants (rather than an Enum) keeps the
    labels readable in prompts without .value access.

    Adding a new source:
      1. Add a constant here.
      2. Add a corresponding block to PreparedContext.to_planner_prompt().
    """
    USER_MEMORY = "user_memory"
    CURRENT_REQUEST = "current_request"
    # Future sources (not yet used):
    # WEB_RESULT = "web_result"
    # CALENDAR_EVENT = "calendar_event"
    # EMAIL = "email"
    # FILE_CONTENT = "file_content"
    # TOOL_RESULT = "tool_result"
    # WORKFLOW_STATE = "workflow_state"


# ---------------------------------------------------------------------------
# PreparedContext
# ---------------------------------------------------------------------------

@dataclass
class PreparedContext:
    """
    Structured context assembled before planning.

    Each source of information is stored separately with clear provenance.
    The to_planner_prompt() method renders a prompt that makes source
    attribution explicit to the planner.

    Future context sources (web results, calendar, etc.) should be added
    as additional fields here, then rendered in to_planner_prompt().
    """
    user_message: str
    memories: list[ScoredMemory] = field(default_factory=list)
    conversation_history: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def has_memories(self) -> bool:
        return len(self.memories) > 0

    def format_memory_block(self) -> str:
        """
        Format retrieved user memories with clear provenance headers.

        The header explicitly labels this block as personal user memory,
        distinguishing it from the model's general world knowledge.
        """
        if not self.memories:
            return ""

        lines = [
            "### USER MEMORY",
            "[Retrieved from personal persistent memory. "
            "This is user-specific information. "
            "Do NOT confuse with general world knowledge.]",
        ]
        for idx, sm in enumerate(self.memories, 1):
            mem = sm.memory
            type_label = mem.memory_type.value.capitalize()
            lines.append(
                f"{idx}. [{type_label} Memory - Scope: {mem.scope.value}] {mem.content}"
            )

        return "\n".join(lines)

    def to_planner_prompt(self) -> str:
        """
        Render the full prompt sent to the planner.

        Structure:
          [USER MEMORY block — only if memories exist]
          ### CURRENT USER REQUEST
          [user message]

        Each section is clearly labeled so the planner's prompt instructions
        can refer to sections by name and understand their provenance.
        """
        parts: list[str] = []

        memory_block = self.format_memory_block()
        if memory_block:
            parts.append(memory_block)

        # Future context sources would be added here, e.g.:
        # if self.web_results:
        #     parts.append(self.format_web_results_block())

        parts.append(f"### CURRENT USER REQUEST\n{self.user_message}")

        return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# ContextBuilder
# ---------------------------------------------------------------------------

class ContextBuilder:
    def __init__(self, memory_manager: MemoryManager | None = None):
        self.memory_manager = memory_manager

    def build_context(
        self,
        user_message: str,
        conversation_history: list[dict[str, str]] | None = None,
        top_k: int = 5,
        min_similarity: float | None = None,
        scope: Any = None,
        project_id: str | None = None,
        user_id: str | None = None,
        conversation_id: str | None = None,
    ) -> PreparedContext:
        """
        Build structured, provenance-labeled context for the planner.

        Retrieves relevant user memories and assembles them alongside
        the current request with clear source attribution.

        Graceful degradation: if memory retrieval fails for any reason,
        the context is built without memories and a warning is logged.
        """
        memories: list[ScoredMemory] = []
        clean_msg = user_message.strip() if user_message else ""

        # Avoid unnecessary vector retrieval for trivial single-word greetings
        is_trivial = not clean_msg or clean_msg.lower() in {
            "hi", "hello", "hey", "exit", "quit", "bye", "thanks", "ok"
        }

        if not is_trivial and self.memory_manager is not None and self.memory_manager.is_enabled():
            try:
                memories = self.memory_manager.retrieve(
                    query=user_message,
                    top_k=top_k,
                    min_similarity=min_similarity,
                    scope=scope,
                    project_id=project_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                )
            except Exception as e:
                logger.warning(
                    "[MEMORY_FAILURE] ContextBuilder failed to retrieve memories: %s", e
                )
                memories = []

        return PreparedContext(
            user_message=user_message,
            memories=memories,
            conversation_history=conversation_history or [],
            metadata={
                "project_id": project_id,
                "user_id": user_id,
                "conversation_id": conversation_id,
            },
        )
