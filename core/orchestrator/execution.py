from typing import Literal

from pydantic import BaseModel, Field


class StepResult(BaseModel):
    step_id: str
    capability: str
    success: bool
    output: str | None = None
    error: str | None = None


class ExecutionState(BaseModel):
    status: Literal[
        "pending",
        "running",
        "completed",
        "failed",
    ] = "pending"

    current_step: str | None = None

    completed_steps: list[str] = Field(
        default_factory=list
    )

    failed_steps: list[str] = Field(
        default_factory=list
    )

    results: list[StepResult] = Field(
        default_factory=list
    )

    attempt: int = 1


class ExecutionResult(BaseModel):
    success: bool
    results: list[StepResult]

    def observation(self) -> str:

        if self.success:

            outputs = []

            for result in self.results:

                if result.output:

                    outputs.append(
                        f"{result.step_id}: {result.output}"
                    )

            return "\n".join(outputs)

        errors = []

        for result in self.results:

            if result.error:

                errors.append(
                    f"{result.step_id}: {result.error}"
                )

        return "\n".join(errors)