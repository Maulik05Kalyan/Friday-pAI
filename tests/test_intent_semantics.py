"""
M5.5 Tests — Memory-Aware Intent & Operations.

Tests semantic invariants, validator enforcement, structured-output robustness,
and the intent taxonomy.  These tests do NOT call a live LLM — they test the
deterministic layers:
  - Schema validation
  - Validator intent invariants
  - Structured-output parser (planner._safe_parse, _extract_json)
  - Capability dispatch (memory_operation routing)
  - Context builder provenance
  - Graceful degradation

Tests are grouped by concern and labeled to match the milestone spec.
"""
import json
import pytest
from pydantic import ValidationError

from core.orchestrator.schemas import TaskPlan, TaskStep
from core.orchestrator.validator import (
    PlanValidationError,
    validate_plan,
)
from core.orchestrator.planner import _safe_parse, _extract_json
from core.memory.manager import MemoryManager
from core.memory.context_builder import ContextBuilder
from core.memory.vector_store import InMemoryVectorStore
from core.memory.embeddings import DeterministicMockEmbeddingProvider
from core.memory.config import MemoryConfig
from core.memory.schemas import MemoryType, MemoryScope


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_plan(
    intent,
    steps,
    requires_memory=False,
    complexity="simple",
    requires_tools=False,
) -> TaskPlan:
    return TaskPlan(
        goal="test",
        intent=intent,
        complexity=complexity,
        requires_memory=requires_memory,
        requires_tools=requires_tools,
        steps=steps,
    )


def make_step(capability, memory_operation="none", purpose="test", step_id="step_1", depends_on=None):
    return {
        "id": step_id,
        "capability": capability,
        "memory_operation": memory_operation,
        "purpose": purpose,
        "depends_on": depends_on or [],
    }


# ===========================================================================
# Part 1 — Intent taxonomy: Schema validation
# ===========================================================================

class TestIntentTaxonomy:
    """Pydantic enforces the IntentType literal set."""

    def test_valid_knowledge_query_intent(self):
        plan = make_plan("knowledge_query", [make_step("knowledge")])
        assert plan.intent == "knowledge_query"

    def test_valid_memory_query_intent(self):
        plan = make_plan("memory_query", [make_step("memory", "retrieve")])
        assert plan.intent == "memory_query"

    def test_valid_memory_write_intent(self):
        plan = make_plan("memory_write", [make_step("memory", "store")])
        assert plan.intent == "memory_write"

    def test_valid_memory_forget_intent(self):
        plan = make_plan("memory_forget", [make_step("memory", "forget")])
        assert plan.intent == "memory_forget"

    def test_valid_memory_suppress_intent(self):
        plan = make_plan("memory_suppress", [make_step("memory", "suppress")])
        assert plan.intent == "memory_suppress"

    def test_valid_conversation_intent(self):
        plan = make_plan("conversation", [make_step("knowledge")])
        assert plan.intent == "conversation"

    def test_valid_tool_action_intent(self):
        plan = make_plan("tool_action", [make_step("knowledge")])
        assert plan.intent == "tool_action"

    def test_valid_workflow_intent(self):
        plan = make_plan("workflow", [make_step("knowledge")])
        assert plan.intent == "workflow"

    def test_invalid_intent_rejected_by_pydantic(self):
        """Free-form intents from old system are now rejected."""
        with pytest.raises(ValidationError):
            make_plan("informational", [make_step("knowledge")])

    def test_invalid_intent_continue_rejected(self):
        with pytest.raises(ValidationError):
            make_plan("continue", [make_step("knowledge")])

    def test_invalid_intent_test_rejected(self):
        with pytest.raises(ValidationError):
            make_plan("test", [make_step("knowledge")])


# ===========================================================================
# Part 2 — Memory operation field validation
# ===========================================================================

class TestMemoryOperationField:
    """Pydantic enforces MemoryOperation literal set."""

    def test_valid_memory_operations(self):
        for op in ["retrieve", "store", "forget", "suppress"]:
            step = TaskStep(**make_step("memory", op))
            assert step.memory_operation == op

    def test_knowledge_step_defaults_to_none(self):
        step = TaskStep(**make_step("knowledge"))
        assert step.memory_operation == "none"

    def test_invalid_memory_operation_rejected(self):
        with pytest.raises(ValidationError):
            TaskStep(**make_step("memory", "write"))  # "write" is not valid

    def test_invalid_memory_operation_delete_rejected(self):
        with pytest.raises(ValidationError):
            TaskStep(**make_step("memory", "delete"))


# ===========================================================================
# Part 3 — Validator semantic intent invariants
# ===========================================================================

class TestValidatorIntentInvariants:
    """
    Spec §Part 5: Validator must enforce semantic invariants deterministically.
    The LLM cannot bypass these checks.
    """

    # --- memory_query → must have memory retrieve step ---

    def test_memory_query_requires_retrieve_step(self):
        """memory_query intent with no retrieve step → rejected."""
        plan = make_plan(
            "memory_query",
            [make_step("knowledge")],  # knowledge step, not memory
        )
        with pytest.raises(PlanValidationError, match="retrieve"):
            validate_plan(plan)

    def test_memory_query_with_knowledge_only_rejected(self):
        """
        This is the core bug case from the milestone:
        'What OS do I like?' must NOT be served by knowledge capability.
        """
        plan = make_plan(
            "memory_query",
            [make_step("knowledge", "none", "retrieve user OS preference")],
        )
        with pytest.raises(PlanValidationError):
            validate_plan(plan)

    def test_memory_query_with_retrieve_step_passes(self):
        plan = make_plan(
            "memory_query",
            [make_step("memory", "retrieve")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_query"

    # --- memory_write → must have memory store step ---

    def test_memory_write_requires_store_step(self):
        """memory_write intent with no store step → rejected."""
        plan = make_plan(
            "memory_write",
            [make_step("knowledge")],
        )
        with pytest.raises(PlanValidationError, match="store"):
            validate_plan(plan)

    def test_memory_write_with_retrieve_instead_of_store_rejected(self):
        """Wrong operation type — retrieve instead of store."""
        plan = make_plan(
            "memory_write",
            [make_step("memory", "retrieve")],
        )
        with pytest.raises(PlanValidationError):
            validate_plan(plan)

    def test_memory_write_with_store_step_passes(self):
        plan = make_plan(
            "memory_write",
            [make_step("memory", "store")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_write"

    # --- memory_forget → must have memory forget step ---

    def test_memory_forget_requires_forget_step(self):
        plan = make_plan(
            "memory_forget",
            [make_step("knowledge")],
        )
        with pytest.raises(PlanValidationError, match="forget"):
            validate_plan(plan)

    def test_memory_forget_with_forget_step_passes(self):
        plan = make_plan(
            "memory_forget",
            [make_step("memory", "forget")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_forget"

    # --- memory_suppress → must have memory suppress step ---

    def test_memory_suppress_requires_suppress_step(self):
        plan = make_plan(
            "memory_suppress",
            [make_step("knowledge")],
        )
        with pytest.raises(PlanValidationError, match="suppress"):
            validate_plan(plan)

    def test_memory_suppress_with_suppress_step_passes(self):
        plan = make_plan(
            "memory_suppress",
            [make_step("memory", "suppress")],
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_suppress"

    # --- knowledge_query → must NOT have memory retrieve step ---

    def test_knowledge_query_must_not_have_memory_retrieve(self):
        """
        Spec §Part 5: 'What is Linux?' must not trigger memory retrieval.
        This is the second half of the core bug.
        """
        plan = make_plan(
            "knowledge_query",
            [make_step("memory", "retrieve", "retrieve Linux info")],
        )
        with pytest.raises(PlanValidationError, match="must not include"):
            validate_plan(plan)

    def test_knowledge_query_with_knowledge_step_passes(self):
        plan = make_plan(
            "knowledge_query",
            [make_step("knowledge", "none", "explain Linux")],
        )
        validated = validate_plan(plan)
        assert validated.intent == "knowledge_query"

    # --- memory_operation consistency ---

    def test_knowledge_step_with_memory_operation_rejected(self):
        """knowledge step must have memory_operation='none'."""
        plan = make_plan(
            "knowledge_query",
            [make_step("knowledge", "retrieve")],
        )
        with pytest.raises(PlanValidationError, match="Non-memory steps"):
            validate_plan(plan)

    def test_memory_step_with_none_operation_rejected(self):
        """memory step must have an explicit memory operation."""
        plan = make_plan(
            "memory_query",
            [make_step("memory", "none")],
        )
        with pytest.raises(PlanValidationError):
            validate_plan(plan)

    # --- Malformed plan scenarios from spec ---

    def test_malformed_intent_memory_query_capability_knowledge_rejected(self):
        """
        Spec §Part 11, test 7:
        intent=memory_query but capability=knowledge → validator rejects.
        """
        plan = make_plan(
            "memory_query",
            [make_step("knowledge", "none", "retrieve user OS preference")],
        )
        with pytest.raises(PlanValidationError):
            validate_plan(plan)

    def test_malformed_intent_memory_write_no_store_rejected(self):
        """
        Spec §Part 11, test 8:
        intent=memory_write but no memory.store operation → validator rejects.
        """
        plan = make_plan(
            "memory_write",
            [make_step("knowledge", "none", "answer question")],
        )
        with pytest.raises(PlanValidationError):
            validate_plan(plan)

    def test_tools_unavailable_rejected(self):
        plan = make_plan(
            "tool_action",
            [make_step("knowledge")],
            requires_tools=True,
        )
        with pytest.raises(PlanValidationError, match="External tools"):
            validate_plan(plan)

    def test_empty_plan_rejected(self):
        with pytest.raises(PlanValidationError, match="at least one step"):
            validate_plan(make_plan("knowledge_query", []))

    def test_duplicate_step_ids_rejected(self):
        plan = make_plan(
            "knowledge_query",
            [
                make_step("knowledge", "none", "step one", "step_1"),
                make_step("knowledge", "none", "step two", "step_1"),
            ],
        )
        with pytest.raises(PlanValidationError, match="unique"):
            validate_plan(plan)

    def test_unknown_capability_rejected(self):
        plan = make_plan(
            "knowledge_query",
            [make_step("web_search", "none")],
        )
        with pytest.raises(PlanValidationError, match="Unknown capability"):
            validate_plan(plan)


# ===========================================================================
# Part 4 — Structured-output parser robustness
# ===========================================================================

class TestStructuredOutputParser:
    """
    Spec §Part 10: The planner must handle messy LLM output safely.
    """

    def test_clean_json_parses(self):
        raw = '{"key": "value"}'
        result = _safe_parse(raw)
        assert result == {"key": "value"}

    def test_json_with_surrounding_text_extracted(self):
        """
        Spec §Part 11, test 9: JSON surrounded by explanatory text is handled.
        """
        raw = 'Here is my plan:\n{"key": "value"}\nEnd of output.'
        result = _safe_parse(raw)
        assert result == {"key": "value"}

    def test_json_with_line_comments_stripped(self):
        """
        Spec §Part 10: Comments inside JSON are stripped before parsing.
        The original bug that caused 'Expecting comma delimiter'.
        """
        raw = '{\n  "key": "value" // this is a comment\n}'
        result = _safe_parse(raw)
        assert result == {"key": "value"}

    def test_json_with_block_comments_stripped(self):
        raw = '{\n  /* comment */ "key": "value"\n}'
        result = _safe_parse(raw)
        assert result == {"key": "value"}

    def test_json_with_trailing_comma_fixed(self):
        raw = '{"key": "value",}'
        result = _safe_parse(raw)
        assert result == {"key": "value"}

    def test_json_after_think_block_extracted(self):
        """
        ModelGateway strips <think> blocks. This test ensures the pipeline
        handles output where thinks were already stripped by the gateway,
        leaving only the JSON.
        """
        # This simulates what ModelGateway returns after stripping <think>
        raw = '{"key": "value", "nested": {"a": 1}}'
        result = _safe_parse(raw)
        assert result == {"key": "value", "nested": {"a": 1}}

    def test_empty_output_raises_value_error(self):
        """
        Spec §Part 11, test 10: Invalid JSON fails safely.
        """
        with pytest.raises(ValueError, match="empty output"):
            _safe_parse("")

    def test_no_json_object_raises_value_error(self):
        with pytest.raises(ValueError):
            _safe_parse("There is no JSON here at all.")

    def test_incomplete_json_raises_value_error(self):
        """
        Spec §Part 11, test 10: Incomplete JSON fails safely.
        """
        with pytest.raises(ValueError):
            _safe_parse('{"key": "value"')

    def test_multiple_json_objects_uses_first(self):
        """
        Spec §Part 10: Multiple JSON objects — use first valid one.
        """
        raw = '{"goal": "first"}\n{"goal": "second"}'
        result = _safe_parse(raw)
        assert result["goal"] == "first"

    def test_extract_json_finds_nested_object(self):
        raw = 'prefix {"outer": {"inner": 1}} suffix'
        extracted = _extract_json(raw)
        data = json.loads(extracted)
        assert data["outer"]["inner"] == 1

    def test_malformed_json_not_silently_converted(self):
        """
        Spec §Part 10: Do NOT silently convert malformed plans into guessed plans.
        """
        raw = '{"key": INVALID}'
        with pytest.raises(ValueError):
            _safe_parse(raw)


# ===========================================================================
# Part 5 — Context builder provenance
# ===========================================================================

class TestContextProvenance:
    """
    Spec §Part 6: Retrieved memories must be distinguishable from other context.
    """

    def _make_manager(self):
        return MemoryManager(
            config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
            vector_store=InMemoryVectorStore(),
            embedding_provider=DeterministicMockEmbeddingProvider(8),
        )

    def test_user_memory_block_has_provenance_label(self):
        manager = self._make_manager()
        manager.remember("User prefers Python over Java.")
        builder = ContextBuilder(memory_manager=manager)
        ctx = builder.build_context("What do I prefer?", min_similarity=0.0)

        prompt = ctx.to_planner_prompt()
        assert "### USER MEMORY" in prompt
        assert "personal persistent memory" in prompt.lower()

    def test_current_request_section_present(self):
        manager = self._make_manager()
        builder = ContextBuilder(memory_manager=manager)
        ctx = builder.build_context("Hello there")
        prompt = ctx.to_planner_prompt()
        assert "### CURRENT USER REQUEST" in prompt
        assert "Hello there" in prompt

    def test_no_memory_returns_plain_request(self):
        """When no memories found, prompt is just the user request."""
        manager = self._make_manager()
        builder = ContextBuilder(memory_manager=manager)
        ctx = builder.build_context("What is Python?")
        prompt = ctx.to_planner_prompt()
        assert "### USER MEMORY" not in prompt
        assert "### CURRENT USER REQUEST" in prompt

    def test_memory_provenance_label_distinguishes_from_knowledge(self):
        """
        The label must explicitly indicate this is personal/user memory,
        not world knowledge.
        """
        manager = self._make_manager()
        manager.remember("User's OS is Linux.")
        builder = ContextBuilder(memory_manager=manager)
        # Use the exact stored text as query + min_similarity=0.0 to ensure
        # DeterministicMockEmbeddingProvider returns the memory (it uses
        # deterministic hashing, so identical strings have high similarity).
        ctx = builder.build_context("User's OS is Linux.", min_similarity=0.0)
        prompt = ctx.to_planner_prompt()
        # Must clearly label the source as user-specific memory
        assert "USER MEMORY" in prompt
        # Must warn about not confusing with general knowledge
        assert "user-specific" in prompt.lower() or "personal" in prompt.lower()

    def test_has_memories_property(self):
        manager = self._make_manager()
        builder = ContextBuilder(memory_manager=manager)

        ctx_empty = builder.build_context("test")
        assert ctx_empty.has_memories is False

        manager.remember("Some fact.")
        ctx_with = builder.build_context("test", min_similarity=0.0)
        assert ctx_with.has_memories is True


# ===========================================================================
# Part 6 — Memory capability dispatch
# ===========================================================================

class TestMemoryCapabilityDispatch:
    """
    Spec §Part 3: The executor can distinguish memory operations being requested.
    """

    def _make_manager(self):
        return MemoryManager(
            config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
            vector_store=InMemoryVectorStore(),
            embedding_provider=DeterministicMockEmbeddingProvider(8),
        )

    def _make_handler(self, manager):
        """Return a memory_handler with a specific manager injected."""
        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager
        return original

    def test_memory_store_persists_memory(self):
        manager = self._make_manager()
        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager

        try:
            step = TaskStep(
                id="step_1",
                capability="memory",
                memory_operation="store",
                purpose="User prefers Linux as OS",
            )
            from core.orchestrator.capabilities import memory_handler
            result = memory_handler(step, "Remember that I like Linux.")

            assert "stored" in result.lower() or "personal memory" in result.lower()
            mems = manager.list()
            assert len(mems) >= 1
        finally:
            cap_module._default_memory_manager = original

    def test_memory_retrieve_returns_relevant_memories(self):
        manager = self._make_manager()
        manager.remember("User prefers Linux as their OS.")

        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager

        try:
            step = TaskStep(
                id="step_1",
                capability="memory",
                memory_operation="retrieve",
                purpose="user preferred OS",
            )
            from core.orchestrator.capabilities import memory_handler
            result = memory_handler(step, "What OS do I like?")

            assert "Linux" in result or "personal memory" in result.lower()
        finally:
            cap_module._default_memory_manager = original

    def test_memory_forget_deactivates_memory(self):
        try:
            from core.memory.embeddings import SentenceTransformerEmbeddingProvider
            emb = SentenceTransformerEmbeddingProvider("all-MiniLM-L6-v2")
        except Exception:
            pytest.skip("SentenceTransformer not available")

        manager = MemoryManager(
            config=MemoryConfig(embedding_dimension=384, similarity_threshold=0.3),
            vector_store=InMemoryVectorStore(),
            embedding_provider=emb,
        )
        manager.remember("User prefers Linux.")

        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager

        try:
            step = TaskStep(
                id="step_1",
                capability="memory",
                memory_operation="forget",
                purpose="User prefers Linux",
            )
            from core.orchestrator.capabilities import memory_handler
            result = memory_handler(step, "Forget that I like Linux.")

            assert "deactivated" in result.lower() or "forget" in result.lower()
            from core.memory.schemas import MemoryFilter
            active = manager.list(filter=MemoryFilter(active_only=True))
            assert len(active) == 0
        finally:
            cap_module._default_memory_manager = original

    def test_memory_suppress_returns_suppression_message(self):
        manager = self._make_manager()

        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager

        try:
            step = TaskStep(
                id="step_1",
                capability="memory",
                memory_operation="suppress",
                purpose="suppress memory for this interaction",
            )
            from core.orchestrator.capabilities import memory_handler
            result = memory_handler(step, "Don't remember this conversation.")
            assert "suppressed" in result.lower()
        finally:
            cap_module._default_memory_manager = original

    def test_memory_retrieve_returns_not_found_gracefully(self):
        """
        Spec §Part 11, test 11: Memory unavailable → graceful degradation.
        """
        manager = self._make_manager()
        # No memories stored

        import core.orchestrator.capabilities as cap_module
        original = cap_module._default_memory_manager
        cap_module._default_memory_manager = manager

        try:
            step = TaskStep(
                id="step_1",
                capability="memory",
                memory_operation="retrieve",
                purpose="user OS preference",
            )
            from core.orchestrator.capabilities import memory_handler
            result = memory_handler(step, "What OS do I use?")
            # Must clearly communicate that no personal memory was found
            assert "no relevant memories" in result.lower() or "not currently stored" in result.lower()
        finally:
            cap_module._default_memory_manager = original


# ===========================================================================
# Part 7 — Graceful degradation
# ===========================================================================

class TestGracefulDegradation:
    """
    Spec §Part 11, test 11: Existing graceful degradation remains intact.
    """

    def test_qdrant_failure_context_builder_degrades(self):
        """ContextBuilder fails gracefully if memory retrieval throws."""
        class FailingMemoryManager:
            def is_enabled(self):
                return True
            def retrieve(self, *args, **kwargs):
                raise ConnectionError("Qdrant unreachable")

        builder = ContextBuilder(memory_manager=FailingMemoryManager())
        ctx = builder.build_context("What is my project?")
        # Should return a context with no memories rather than crashing
        assert ctx.has_memories is False
        assert "What is my project?" in ctx.to_planner_prompt()

    def test_disabled_memory_returns_empty_context(self):
        manager = MemoryManager(
            config=MemoryConfig(enabled=False, embedding_dimension=8),
            vector_store=InMemoryVectorStore(),
            embedding_provider=DeterministicMockEmbeddingProvider(8),
        )
        builder = ContextBuilder(memory_manager=manager)
        ctx = builder.build_context("What do I prefer?")
        assert ctx.has_memories is False


# ===========================================================================
# Part 8 — Full valid plan round-trips
# ===========================================================================

class TestFullPlanRoundTrips:
    """
    Spec §Part 11: Verify the full semantic scenarios pass validation.
    """

    def test_linux_remember_plan_validates(self):
        """'Remember that I like to work on Linux.' → memory_write → memory.store"""
        plan = make_plan(
            intent="memory_write",
            steps=[make_step("memory", "store", "User likes to work on Linux")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_write"
        assert validated.steps[0].memory_operation == "store"

    def test_linux_os_query_plan_validates(self):
        """'What OS do I like to work on?' → memory_query → memory.retrieve"""
        plan = make_plan(
            intent="memory_query",
            steps=[make_step("memory", "retrieve", "user preferred OS")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_query"
        assert validated.steps[0].memory_operation == "retrieve"

    def test_forget_linux_plan_validates(self):
        """'Forget that I like Linux.' → memory_forget → memory.forget"""
        plan = make_plan(
            intent="memory_forget",
            steps=[make_step("memory", "forget", "user Linux preference")],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_forget"
        assert validated.steps[0].memory_operation == "forget"

    def test_dont_remember_plan_validates(self):
        """'Don't remember this conversation.' → memory_suppress → memory.suppress"""
        plan = make_plan(
            intent="memory_suppress",
            steps=[make_step("memory", "suppress", "suppress memory for this session")],
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_suppress"

    def test_what_is_linux_plan_validates(self):
        """'What is Linux?' → knowledge_query → knowledge step, no memory retrieve"""
        plan = make_plan(
            intent="knowledge_query",
            steps=[make_step("knowledge", "none", "explain what Linux is")],
        )
        validated = validate_plan(plan)
        assert validated.intent == "knowledge_query"
        assert validated.steps[0].capability == "knowledge"
        assert validated.steps[0].memory_operation == "none"

    def test_how_does_linux_work_validates(self):
        """'How does Linux work?' → knowledge_query"""
        plan = make_plan(
            intent="knowledge_query",
            steps=[make_step("knowledge", "none", "explain how Linux works")],
        )
        validated = validate_plan(plan)
        assert validated.intent == "knowledge_query"

    def test_multi_step_plan_validates(self):
        """Multi-step plan with dependencies."""
        plan = make_plan(
            intent="memory_query",
            steps=[
                make_step("memory", "retrieve", "retrieve user preferences", "step_1"),
                {
                    "id": "step_2",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "explain based on retrieved preferences",
                    "depends_on": ["step_1"],
                },
            ],
            requires_memory=True,
        )
        validated = validate_plan(plan)
        assert validated.intent == "memory_query"
        assert len(validated.steps) == 2
