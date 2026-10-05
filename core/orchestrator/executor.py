from core.orchestrator.capabilities import CAPABILITIES
from core.orchestrator.execution import (
    ExecutionResult,
    ExecutionState,
    StepResult,
)
from core.orchestrator.schemas import TaskPlan


class Executor:

    def __init__(self):

        self.state = ExecutionState()

    def execute(
        self,
        plan: TaskPlan,
        user_message: str,
    ) -> ExecutionResult:

        self.state = ExecutionState(
            status="running"
        )

        remaining = {
            step.id: step
            for step in plan.steps
        }

        while remaining:

            executable_steps = []

            for step in remaining.values():

                dependencies_satisfied = all(
                    dependency in self.state.completed_steps
                    for dependency in step.depends_on
                )

                if dependencies_satisfied:
                    executable_steps.append(step)

            # Nothing can execute.
            # This means the dependency graph is invalid.
            if not executable_steps:

                self.state.status = "failed"

                error = (
                    "Execution blocked: "
                    "no remaining step has all "
                    "dependencies satisfied."
                )

                result = StepResult(
                    step_id="execution",
                    capability="runtime",
                    success=False,
                    error=error,
                )

                self.state.results.append(result)

                return ExecutionResult(
                    success=False,
                    results=self.state.results,
                )

            # Execute one ready step.
            step = executable_steps[0]

            self.state.current_step = step.id

            handler = CAPABILITIES.get(
                step.capability
            )

            if handler is None:

                self.state.status = "failed"
                self.state.failed_steps.append(step.id)

                result = StepResult(
                    step_id=step.id,
                    capability=step.capability,
                    success=False,
                    error=(
                        f"No handler registered for "
                        f"capability '{step.capability}'."
                    ),
                )

                self.state.results.append(result)

                return ExecutionResult(
                    success=False,
                    results=self.state.results,
                )

            try:

                output = handler(
                    step,
                    user_message,
                )

                result = StepResult(
                    step_id=step.id,
                    capability=step.capability,
                    success=True,
                    output=output,
                )

                self.state.results.append(result)

                self.state.completed_steps.append(
                    step.id
                )

                del remaining[step.id]

            except Exception as exc:

                self.state.status = "failed"
                self.state.failed_steps.append(step.id)

                result = StepResult(
                    step_id=step.id,
                    capability=step.capability,
                    success=False,
                    error=str(exc),
                )

                self.state.results.append(result)

                return ExecutionResult(
                    success=False,
                    results=self.state.results,
                )

        self.state.current_step = None
        self.state.status = "completed"

        return ExecutionResult(
            success=True,
            results=self.state.results,
        )