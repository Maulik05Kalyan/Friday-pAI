from core.models.gateway import ModelGateway
from core.orchestrator.agent import Agent
from core.orchestrator.executor import Executor
from core.orchestrator.planner import Planner
from core.orchestrator.schemas import TaskPlan
from core.orchestrator.validator import validate_plan
from core.memory.manager import MemoryManager
from core.memory.context_builder import ContextBuilder


class Orchestrator:

    def __init__(
        self,
        memory_manager: MemoryManager | None = None,
        context_builder: ContextBuilder | None = None,
    ):
        self.gateway = ModelGateway()

        self.memory_manager = (
            memory_manager if memory_manager is not None else MemoryManager(gateway=self.gateway)
        )

        self.context_builder = (
            context_builder
            if context_builder is not None
            else ContextBuilder(memory_manager=self.memory_manager)
        )

        self.planner = Planner(
            self.gateway
        )

        self.executor = Executor()

        self.agent = Agent(
            planner=self.planner,
            executor=self.executor,
            context_builder=self.context_builder,
            memory_manager=self.memory_manager,
        )

    def plan(self, user_message: str) -> TaskPlan:
        planner_input = user_message
        if self.context_builder is not None:
            prepared = self.context_builder.build_context(user_message)
            planner_input = prepared.to_planner_prompt()

        plan = self.planner.create_plan(
            planner_input
        )

        return validate_plan(plan)

    def run(self, user_message: str):
        return self.agent.run(
            user_message
        )