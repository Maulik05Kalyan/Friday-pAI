from core.orchestrator.agent import Agent
from core.orchestrator.schemas import TaskPlan
from core.orchestrator.execution import (
    ExecutionResult,
    StepResult,
)


class FakePlanner:

    def __init__(self):
        self.replan_called = False

    def create_plan(self, user_message):

        return TaskPlan(
            goal="test",
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

    def replan(
        self,
        user_message,
        previous_plan,
        observation,
    ):

        self.replan_called = True

        return self.create_plan(user_message)


class FakeExecutor:

    def __init__(self):
        self.calls = 0

    def execute(
        self,
        plan,
        user_message,
    ):

        self.calls += 1

        if self.calls == 1:

            return ExecutionResult(
                success=False,
                results=[
                    StepResult(
                        step_id="step_1",
                        capability="knowledge",
                        success=False,
                        error="Simulated failure",
                    )
                ],
            )

        return ExecutionResult(
            success=True,
            results=[
                StepResult(
                    step_id="step_1",
                    capability="knowledge",
                    success=True,
                    output="Success",
                )
            ],
        )


def test_agent_replans_after_failure():

    planner = FakePlanner()
    executor = FakeExecutor()

    agent = Agent(
        planner=planner,
        executor=executor,
    )

    plan, result = agent.run(
        "test request"
    )

    assert planner.replan_called is True
    assert executor.calls == 2
    assert result.success is True