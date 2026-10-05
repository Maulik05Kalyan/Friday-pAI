"""
Integration tests for Memory + Orchestrator pipeline — M5.5 updated.
"""
from core.orchestrator.agent import Agent
from core.orchestrator.schemas import TaskPlan
from core.orchestrator.execution import ExecutionResult, StepResult
from core.memory.manager import MemoryManager
from core.memory.context_builder import ContextBuilder
from core.memory.vector_store import InMemoryVectorStore
from core.memory.embeddings import SentenceTransformerEmbeddingProvider, DeterministicMockEmbeddingProvider
from core.memory.config import MemoryConfig
from core.memory.schemas import MemoryType, MemoryScope


class MockPlannerWithContextInspection:
    def __init__(self):
        self.received_prompt = None

    def create_plan(self, prompt: str) -> TaskPlan:
        self.received_prompt = prompt
        # M5.5: Context header changed to ### USER MEMORY
        has_memories = "USER MEMORY" in prompt
        return TaskPlan(
            goal="Answer user query with context",
            intent="knowledge_query",
            complexity="simple",
            requires_memory=has_memories,
            requires_tools=False,
            steps=[
                {
                    "id": "step_1",
                    "capability": "knowledge",
                    "memory_operation": "none",
                    "purpose": "answer query",
                    "depends_on": [],
                }
            ],
        )

    def replan(self, user_message, previous_plan, observation):
        return self.create_plan(user_message)


class MockSuccessfulExecutor:
    def execute(self, plan, user_message):
        return ExecutionResult(
            success=True,
            results=[
                StepResult(
                    step_id="step_1",
                    capability="knowledge",
                    success=True,
                    output="Successfully executed with context.",
                )
            ],
        )


def test_user_memory_retrieval_planner_execution():
    """
    Test end-to-end integration:
    USER -> memory retrieval -> planner -> execution

    Verifies that the ContextBuilder injects retrieved memories into
    the planner prompt with provenance-labeled headers.
    """
    emb = DeterministicMockEmbeddingProvider(dimension=16)
    vector_store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=16, similarity_threshold=0.0),
        vector_store=vector_store,
        embedding_provider=emb,
    )

    # Store background memory
    manager.remember(
        content="The primary project name is Project Orion.",
        memory_type=MemoryType.SEMANTIC,
        scope=MemoryScope.USER,
        importance=0.9,
    )

    context_builder = ContextBuilder(memory_manager=manager)
    planner = MockPlannerWithContextInspection()
    executor = MockSuccessfulExecutor()

    agent = Agent(
        planner=planner,
        executor=executor,
        context_builder=context_builder,
        memory_manager=manager,
    )

    plan, result = agent.run("What is my project name?")

    # Verify context builder injected relevant memories with provenance labels
    assert planner.received_prompt is not None
    assert "### USER MEMORY" in planner.received_prompt        # M5.5 header
    assert "Project Orion" in planner.received_prompt
    assert "### CURRENT USER REQUEST" in planner.received_prompt

    # Verify plan requires_memory flag became True
    assert plan.requires_memory is True
    assert result.success is True


def test_user_execution_memory_extraction_persistence():
    """
    Test end-to-end integration:
    USER -> execution -> memory extraction -> memory persistence
    """
    emb = DeterministicMockEmbeddingProvider(dimension=16)
    vector_store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=16, similarity_threshold=0.0),
        vector_store=vector_store,
        embedding_provider=emb,
    )

    context_builder = ContextBuilder(memory_manager=manager)
    planner = MockPlannerWithContextInspection()
    executor = MockSuccessfulExecutor()

    agent = Agent(
        planner=planner,
        executor=executor,
        context_builder=context_builder,
        memory_manager=manager,
    )

    # User explicitly asks to remember a workflow preference
    user_msg = "Remember that I prefer running pytest before committing code."
    plan, result = agent.run(user_msg)

    assert result.success is True

    # Check that memory was extracted and stored in persistent vector store
    memories = manager.list()
    assert len(memories) >= 1
    stored = memories[0]
    assert "pytest before committing" in stored.content
    assert stored.memory_type in (MemoryType.SEMANTIC, MemoryType.PROCEDURAL)
    assert stored.active is True
