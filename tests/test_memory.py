from datetime import datetime, timezone
import pytest
from pydantic import ValidationError

from core.memory.config import MemoryConfig
from core.memory.schemas import (
    Memory,
    MemoryType,
    MemoryScope,
    MemoryFilter,
    MemoryExtractionResult,
)
from core.memory.vector_store import InMemoryVectorStore, QdrantVectorStore
from core.memory.embeddings import (
    DeterministicMockEmbeddingProvider,
    SentenceTransformerEmbeddingProvider,
)
from core.memory.manager import MemoryManager
from core.memory.context_builder import ContextBuilder
from core.memory.privacy import contains_sensitive_data, redact_sensitive_data
from core.memory.decay import calculate_decay_score, calculate_recency_score
from core.memory.ranking import rank_memories


# 1. Memory creation
def test_memory_creation():
    mem = Memory(
        content="I prefer working with Linux containers.",
        memory_type=MemoryType.SEMANTIC,
        scope=MemoryScope.USER,
        importance=0.8,
        confidence=0.9,
        tags=["devops", "docker"],
    )
    assert mem.id is not None
    assert mem.content == "I prefer working with Linux containers."
    assert mem.memory_type == MemoryType.SEMANTIC
    assert mem.scope == MemoryScope.USER
    assert mem.importance == 0.8
    assert mem.confidence == 0.9
    assert mem.access_count == 1
    assert mem.active is True
    assert mem.created_at is not None


# 2. Memory retrieval
def test_memory_retrieval():
    mock_emb = DeterministicMockEmbeddingProvider(dimension=16)
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=16, similarity_threshold=0.0),
        vector_store=store,
        embedding_provider=mock_emb,
    )

    mem = manager.remember("My primary operating system is Ubuntu 24.04.")
    assert mem is not None

    retrieved = manager.retrieve("My primary operating system is Ubuntu 24.04.", top_k=1, min_similarity=-1.0)
    assert len(retrieved) == 1
    assert retrieved[0].memory.content == "My primary operating system is Ubuntu 24.04."
    assert retrieved[0].memory.access_count >= 1


# 3. Semantic search with real SentenceTransformer
def test_semantic_search():
    try:
        emb_provider = SentenceTransformerEmbeddingProvider("all-MiniLM-L6-v2")
    except Exception:
        pytest.skip("SentenceTransformer not available")

    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=384, similarity_threshold=0.4),
        vector_store=store,
        embedding_provider=emb_provider,
    )

    manager.remember("I love programming in Python and Rust.")
    manager.remember("The weather in London is usually cloudy and rainy.")

    # Search query conceptually related to coding
    results = manager.retrieve("What languages do I code in?", top_k=2)
    assert len(results) > 0
    top_hit = results[0]
    assert "Python and Rust" in top_hit.memory.content


# 4. Metadata filtering
def test_metadata_filtering():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
        vector_store=store,
        embedding_provider=emb,
    )

    manager.remember(
        "Project Alpha architecture decision",
        project_id="alpha",
        tags=["architecture"],
    )
    manager.remember(
        "Project Beta deployment steps",
        project_id="beta",
        tags=["deployment"],
    )

    # Filter by project_id
    results_alpha = manager.retrieve("architecture", project_id="alpha", min_similarity=0.0)
    for sm in results_alpha:
        assert sm.memory.project_id == "alpha"

    # List filter by tags
    tag_matches = manager.list(filter=MemoryFilter(tags=["deployment"]))
    assert len(tag_matches) == 1
    assert tag_matches[0].project_id == "beta"


# 5. Deduplication
def test_deduplication():
    try:
        emb_provider = SentenceTransformerEmbeddingProvider("all-MiniLM-L6-v2")
    except Exception:
        pytest.skip("SentenceTransformer not available")

    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=384, dedup_threshold=0.80),
        vector_store=store,
        embedding_provider=emb_provider,
    )

    mem1 = manager.remember("I use Ubuntu as my primary operating system.")
    assert mem1 is not None

    initial_id = mem1.id
    initial_count = mem1.access_count

    # Second very similar memory statement
    mem2 = manager.remember("I run Ubuntu on my main machine.")
    assert mem2 is not None

    # Should reinforce initial memory rather than creating a duplicate
    assert mem2.id == initial_id
    assert mem2.access_count > initial_count
    assert store.count() == 1


# 6. Memory updates
def test_memory_updates():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=emb,
    )

    mem = manager.remember("Initial note about project structure.")
    assert mem is not None

    mem.content = "Updated note with revised project structure."
    mem.importance = 0.95
    updated = manager.update(mem)
    assert updated is True

    fetched = manager.get(mem.id)
    assert fetched is not None
    assert fetched.content == "Updated note with revised project structure."
    assert fetched.importance == 0.95


# 7. Memory deletion (soft delete & hard delete)
def test_memory_deletion():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
        vector_store=store,
        embedding_provider=emb,
    )

    mem = manager.remember("Fact to be forgotten.")
    assert mem is not None

    # Soft delete (active=False)
    manager.delete(mem.id, hard_delete=False)
    retrieved = manager.retrieve("forgotten", min_similarity=0.0)
    assert len(retrieved) == 0

    # Hard delete
    manager.delete(mem.id, hard_delete=True)
    assert manager.get(mem.id) is None


# 8. Explicit forget operation
def test_explicit_forget_operation():
    try:
        emb_provider = SentenceTransformerEmbeddingProvider("all-MiniLM-L6-v2")
    except Exception:
        pytest.skip("SentenceTransformer not available")

    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=384),
        vector_store=store,
        embedding_provider=emb_provider,
    )

    manager.remember("User prefers vim for editing files.")
    assert store.count() == 1

    # Explicit forget
    count = manager.forget("User prefers vim")
    assert count >= 1

    # Active memory count should be 0
    active_mems = manager.list(filter=MemoryFilter(active_only=True))
    assert len(active_mems) == 0


# 9. Memory type classification
def test_memory_type_classification():
    assert MemoryType.WORKING == "working"
    assert MemoryType.EPISODIC == "episodic"
    assert MemoryType.SEMANTIC == "semantic"
    assert MemoryType.PROCEDURAL == "procedural"

    extractor = manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=InMemoryVectorStore(),
        embedding_provider=DeterministicMockEmbeddingProvider(8),
    ).extractor

    # Semantic preference
    res_pref = extractor.extract("I prefer dark mode in my editors.")
    assert res_pref.should_store is True
    assert res_pref.memory_type == MemoryType.SEMANTIC

    # Procedural workflow
    res_proc = extractor.extract("The procedure is to run pytest before merge.")
    assert res_proc.should_store is True
    assert res_proc.memory_type == MemoryType.PROCEDURAL

    # Casual greeting should not be stored
    res_greet = extractor.extract("Hello how are you?")
    assert res_greet.should_store is False


# 10. Importance and confidence validation
def test_importance_confidence_validation():
    # Out of range importance
    with pytest.raises(ValidationError):
        Memory(
            content="test",
            memory_type=MemoryType.SEMANTIC,
            importance=1.5,
        )

    with pytest.raises(ValidationError):
        Memory(
            content="test",
            memory_type=MemoryType.SEMANTIC,
            confidence=-0.1,
        )


# 11. Scope filtering
def test_scope_filtering():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
        vector_store=store,
        embedding_provider=emb,
    )

    manager.remember("Global rule", scope=MemoryScope.GLOBAL)
    manager.remember("User preference", scope=MemoryScope.USER)
    manager.remember("Project detail", scope=MemoryScope.PROJECT)

    user_only = manager.list(filter=MemoryFilter(scope=MemoryScope.USER))
    assert len(user_only) == 1
    assert user_only[0].content == "User preference"


# 12. Context construction
def test_context_construction():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8, similarity_threshold=0.0),
        vector_store=store,
        embedding_provider=emb,
    )
    manager.remember("User works in an Ubuntu environment.")

    builder = ContextBuilder(memory_manager=manager)
    prep = builder.build_context("Write a bash script for my environment.", min_similarity=0.0)

    assert prep.has_memories is True
    prompt = prep.to_planner_prompt()
    assert "### USER MEMORY" in prompt
    assert "Ubuntu environment" in prompt
    assert "### CURRENT USER REQUEST" in prompt
    assert "Write a bash script for my environment." in prompt


# 13. Memory-disabled mode
def test_memory_disabled_mode():
    store = InMemoryVectorStore()
    emb = DeterministicMockEmbeddingProvider(dimension=8)
    manager = MemoryManager(
        config=MemoryConfig(enabled=False, embedding_dimension=8),
        vector_store=store,
        embedding_provider=emb,
    )

    mem = manager.remember("This should not be saved.")
    assert mem is None
    assert store.count() == 0

    results = manager.retrieve("anything")
    assert results == []


# 14. Planner integration with context
def test_planner_integration():
    from core.orchestrator.schemas import TaskPlan
    from core.orchestrator.validator import validate_plan

    plan = TaskPlan(
        goal="Continue yesterday's task with memory",
        intent="memory_query",
        complexity="simple",
        requires_memory=True,
        requires_tools=False,
        steps=[
            {
                "id": "step_1",
                "capability": "memory",
                "memory_operation": "retrieve",
                "purpose": "recall previous decision",
                "depends_on": [],
            }
        ],
    )
    # validate_plan should now succeed when requires_memory is True
    validated = validate_plan(plan)
    assert validated.requires_memory is True


# 15. Invalid embedding dimensions error handling
def test_invalid_embedding_dimensions():
    # 1. Collection dimension mismatch check: collection 'memories' exists with dim 384
    with pytest.raises(ValueError, match="dimension mismatch"):
        QdrantVectorStore(collection_name="memories", dimension=16)

    # 2. Embedding dimension mismatch on adding point
    qdrant = QdrantVectorStore(collection_name="memories", dimension=384)
    bad_mem = Memory(
        content="dimension mismatch",
        memory_type=MemoryType.SEMANTIC,
        embedding=[0.1] * 8,  # only 8 dimensions instead of 384
    )
    with pytest.raises(ValueError, match="dimension mismatch"):
        qdrant.add(bad_mem)


# 16. Vector store failure graceful degradation
def test_vector_store_failures():
    class FailingVectorStore(InMemoryVectorStore):
        def search(self, *args, **kwargs):
            raise ConnectionError("Qdrant cluster unreachable")

        def add(self, *args, **kwargs):
            raise ConnectionError("Qdrant cluster unreachable")

    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=FailingVectorStore(),
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )

    # Operations must degrade gracefully and return None or [] without unhandled crash
    assert manager.remember("test memory") is None
    assert manager.retrieve("test query") == []


# 17. Embedding provider failure graceful degradation
def test_embedding_provider_failures():
    class FailingEmbeddingProvider(DeterministicMockEmbeddingProvider):
        def embed(self, text: str):
            raise RuntimeError("Model inference failed")

    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=InMemoryVectorStore(),
        embedding_provider=FailingEmbeddingProvider(dimension=8),
    )

    assert manager.remember("test failure") is None
    assert manager.retrieve("test query") == []


# Privacy: Secrets & Sensitive Data Filter
def test_privacy_filter():
    assert contains_sensitive_data("my api key is sk-1234567890abcdef12345678") is True
    assert contains_sensitive_data("password=SuperSecretPassword123") is True
    assert contains_sensitive_data("Just a normal message about python") is False

    redacted = redact_sensitive_data("Use sk-abcdef123456789012345678 to authenticate")
    assert "sk-" not in redacted
    assert "[REDACTED_CREDENTIAL]" in redacted

    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=InMemoryVectorStore(),
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    rejected = manager.remember("My openai key is sk-abcdef123456789012345678")
    assert rejected is None


# Memory Decay and Ranking
def test_memory_decay_and_ranking():
    now = datetime.now(timezone.utc)
    old_time = datetime(2025, 1, 1, tzinfo=timezone.utc)

    fresh_mem = Memory(
        content="Fresh memory",
        memory_type=MemoryType.SEMANTIC,
        importance=0.5,
        created_at=now,
        last_accessed_at=now,
        access_count=1,
    )
    old_mem = Memory(
        content="Old low-importance memory",
        memory_type=MemoryType.SEMANTIC,
        importance=0.1,
        created_at=old_time,
        last_accessed_at=old_time,
        access_count=1,
    )

    score_fresh = calculate_decay_score(fresh_mem, current_time=now)
    score_old = calculate_decay_score(old_mem, current_time=now)
    assert score_fresh > score_old

    # Ranking
    candidates = [(fresh_mem, 0.8), (old_mem, 0.8)]
    ranked = rank_memories(candidates, current_time=now)
    assert ranked[0].memory.content == "Fresh memory"


# Edge Case: Empty and whitespace strings
def test_empty_and_whitespace_inputs():
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    assert manager.remember("") is None
    assert manager.remember("   ") is None
    assert manager.retrieve("") == []
    assert manager.retrieve("   ") == []

    builder = ContextBuilder(memory_manager=manager)
    prep = builder.build_context("   ")
    assert prep.has_memories is False
    # M5.5: to_planner_prompt always includes ### CURRENT USER REQUEST section
    assert "### CURRENT USER REQUEST" in prep.to_planner_prompt()
    assert "   " in prep.to_planner_prompt()


# Edge Case: Suppress command prevents storage
def test_suppress_explicit_command_does_not_persist():
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    res = manager.process_interaction("Don't remember this conversation")
    assert res["action"] == "suppressed"
    assert store.count() == 0


# Edge Case: Explicit remember with sensitive credentials is rejected
def test_explicit_remember_rejects_credentials():
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    res = manager.process_interaction("Remember that my secret API key is sk-abcdef1234567890abcdef1234")
    assert store.count() == 0


# Edge Case: Trivial single-word greetings bypass unnecessary retrieval
def test_context_builder_skips_trivial_greetings():
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    manager.remember("User loves Python.")
    builder = ContextBuilder(memory_manager=manager)

    prep = builder.build_context("hello")
    assert prep.has_memories is False
    # M5.5: to_planner_prompt always wraps in ### CURRENT USER REQUEST section
    prompt = prep.to_planner_prompt()
    assert "### CURRENT USER REQUEST" in prompt
    assert "hello" in prompt


# Edge Case: No memories meet high threshold
def test_zero_similarity_matches_return_empty():
    store = InMemoryVectorStore()
    manager = MemoryManager(
        config=MemoryConfig(embedding_dimension=8),
        vector_store=store,
        embedding_provider=DeterministicMockEmbeddingProvider(dimension=8),
    )
    manager.remember("Some specific knowledge note.")
    results = manager.retrieve("completely unrelated query", min_similarity=0.999)
    assert results == []

