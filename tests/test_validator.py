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


# ---------------------------------------------------------------------------
# TaskPlan.assumptions normalisation
#
# LLMs sometimes produce sentinel values instead of a proper list.
# The field_validator on TaskPlan.assumptions must coerce these into []
# without weakening the list[str] schema type.
# ---------------------------------------------------------------------------

def _minimal_plan(**overrides) -> dict:
    """Return a minimal valid plan dict, optionally overriding fields."""
    base = {
        "goal": "test",
        "intent": "knowledge_query",
        "complexity": "simple",
        "requires_memory": False,
        "requires_tools": False,
        "steps": [
            {
                "id": "step_1",
                "capability": "knowledge",
                "memory_operation": "none",
                "purpose": "test step",
                "depends_on": [],
            }
        ],
    }
    base.update(overrides)
    return base


class TestAssumptionsNormalisation:
    """Covers all required assumption input shapes."""

    def test_assumptions_as_empty_list(self):
        """Valid empty list passes through unchanged."""
        plan = TaskPlan(**_minimal_plan(assumptions=[]))
        assert plan.assumptions == []

    def test_assumptions_as_populated_list(self):
        """A list of strings passes through unchanged."""
        plan = TaskPlan(**_minimal_plan(assumptions=["Model may be slow", "Internet available"]))
        assert plan.assumptions == ["Model may be slow", "Internet available"]

    def test_assumptions_as_string_none(self):
        """"none" (case-insensitive) is normalised to []."""
        plan = TaskPlan(**_minimal_plan(assumptions="none"))
        assert plan.assumptions == []

    def test_assumptions_as_string_none_uppercase(self):
        """"NONE" is also normalised to []."""
        plan = TaskPlan(**_minimal_plan(assumptions="NONE"))
        assert plan.assumptions == []

    def test_assumptions_as_null(self):
        """JSON null / Python None is normalised to []."""
        plan = TaskPlan(**_minimal_plan(assumptions=None))
        assert plan.assumptions == []

    def test_assumptions_absent_defaults_to_empty_list(self):
        """When the field is omitted entirely the default is []."""
        data = _minimal_plan()
        data.pop("assumptions", None)
        plan = TaskPlan(**data)
        assert plan.assumptions == []

    def test_assumptions_schema_type_is_list_str(self):
        """The resulting field is always a list[str], never a bare string."""
        for raw in ("none", None, []):
            plan = TaskPlan(**_minimal_plan(assumptions=raw))
            assert isinstance(plan.assumptions, list)
            assert all(isinstance(s, str) for s in plan.assumptions)