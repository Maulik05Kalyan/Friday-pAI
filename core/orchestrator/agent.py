import logging
from typing import Any

from core.orchestrator.executor import Executor
from core.orchestrator.planner import Planner
from core.orchestrator.validator import validate_plan

logger = logging.getLogger(__name__)


class Agent:

    MAX_REPLANS = 2

    def __init__(
        self,
        planner: Planner,
        executor: Executor,
        context_builder: Any = None,
        memory_manager: Any = None,
    ):
        self.planner = planner
        self.executor = executor
        self.context_builder = context_builder
        self.memory_manager = memory_manager

    def run(self, user_message: str):
        # 1. Context Builder: augment prompt with relevant memories
        planner_prompt = user_message
        if self.context_builder is not None:
            try:
                prepared = self.context_builder.build_context(user_message)
                planner_prompt = prepared.to_planner_prompt()
            except Exception as e:
                logger.warning(f"Context building failed, proceeding with raw user message: {e}")
                planner_prompt = user_message

        # 2. Planning
        plan = self.planner.create_plan(planner_prompt)

        # 3. Validation
        plan = validate_plan(plan)

        # 4. Execution + Observation + Replanning loop
        final_result = None
        for attempt in range(self.MAX_REPLANS + 1):

            print(f"\n=== EXECUTION ATTEMPT {attempt + 1} ===")

            result = self.executor.execute(
                plan,
                user_message,
            )

            print("\n--- OBSERVATION ---")
            print(result.observation())

            if result.success:
                final_result = result
                break

            if attempt >= self.MAX_REPLANS:
                print("\nMaximum replans reached.")
                final_result = result
                break

            print("\nExecution failed.")
            print("Replanning...\n")

            plan = self.planner.replan(
                user_message=user_message,
                previous_plan=plan,
                observation=result.observation(),
            )

            plan = validate_plan(plan)

        # 5. Memory Update: extract & persist memory candidates if execution succeeded
        if final_result and final_result.success and self.memory_manager is not None:
            try:
                self.memory_manager.process_interaction(user_message)
            except Exception as e:
                logger.warning(f"Memory update failed gracefully: {e}")

        return plan, (final_result or result)