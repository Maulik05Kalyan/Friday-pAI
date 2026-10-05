"""
Validator tests — updated for M5.5 typed schemas and intent invariants.
"""
import pytest

from core.orchestrator.schemas import TaskPlan
from core.orchestrator.validator import (
    validate_plan,
    PlanValidationError,
)


def test_unknown_capability_is_rejected():

    plan = TaskPlan(
        goal="Do something dangerous",
        intent="knowledge_query",
        complexity="simple",
        requires_memory=False,
        requires_tools=False,
        steps=[
            {
                "id": "step_1",
                "capability": "delete_files",
                "memory_operation": "none",
                "purpose": "delete files",
                "depends_on": [],
            }
        ],
    )

    with pytest.raises(PlanValidationError):
        validate_plan(plan)