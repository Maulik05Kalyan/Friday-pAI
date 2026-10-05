"""
Executor tests — updated for M5.5 typed schemas.

These tests exercise execution logic directly without running the validator,
so they use mock capabilities. Plans use valid M5.5 intent and memory_operation
values.
"""
from core.orchestrator.executor import Executor
from core.orchestrator.schemas import TaskPlan


def test_executor_respects_dependencies():

    execution_order = []

    class TestExecutor(Executor):
        pass

    from core.orchestrator import executor as executor_module

    original_capabilities = executor_module.CAPABILITIES

    def handler(step, user_message):
        execution_order.append(step.id)
        return f"executed {step.id}"

    executor_module.CAPABILITIES = {"knowledge": handler}

    try:
        plan = TaskPlan(
            goal="test dependency ordering",
            intent="knowledge_query",
            complexity="medium",
            requires_memory=False,
            requires_tools=False,
            steps=[
                {
                    "id": "step_3",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "third step",
                    "depends_on": ["step_2"],
                },
                {
                    "id": "step_1",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "first step",
                    "depends_on": [],
                },
                {
                    "id": "step_2",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "second step",
                    "depends_on": ["step_1"],
                },
            ],
        )

        executor = Executor()
        result = executor.execute(plan, "test")

        assert result.success is True
        assert execution_order == ["step_1", "step_2", "step_3"]

    finally:
        executor_module.CAPABILITIES = original_capabilities


def test_executor_detects_blocked_dependencies():

    plan = TaskPlan(
        goal="test cycle",
        intent="knowledge_query",
        complexity="simple",
        requires_memory=False,
        requires_tools=False,
        steps=[
            {
                "id": "step_1",
                "capability": "knowledge",
                "memory_operation": "none",
                "purpose": "first",
                "depends_on": ["step_2"],
            },
            {
                "id": "step_2",
                "capability": "knowledge",
                "memory_operation": "none",
                "purpose": "second",
                "depends_on": ["step_1"],
            },
        ],
    )

    executor = Executor()
    result = executor.execute(plan, "test")

    assert result.success is False
    assert "blocked" in result.results[-1].error.lower()


def test_execution_state_tracks_completed_steps():
    # The test verifies execution STATE tracking, not LLM connectivity.
    # Patch CAPABILITIES with a no-op handler (same pattern as
    # test_executor_respects_dependencies) so the step succeeds without
    # requiring a live local model server.
    from core.orchestrator import executor as executor_module

    original_capabilities = executor_module.CAPABILITIES

    def noop_handler(step, user_message):
        return "ok"

    executor_module.CAPABILITIES = {"knowledge": noop_handler}

    try:
        plan = TaskPlan(
            goal="test state",
            intent="knowledge_query",
            complexity="simple",
            requires_memory=False,
            requires_tools=False,
            steps=[
                {
                    "id": "step_1",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "test",
                    "depends_on": [],
                }
            ],
        )

        executor = Executor()
        result = executor.execute(plan, "test")

        assert result.success is True
        assert executor.state.status == "completed"
        assert executor.state.current_step is None
        assert executor.state.completed_steps == ["step_1"]
        assert executor.state.failed_steps == []

    finally:
        executor_module.CAPABILITIES = original_capabilities