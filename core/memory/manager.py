from datetime import datetime, timezone
import logging
from typing import Any

from core.memory.config import MemoryConfig, get_memory_config
from core.memory.embeddings import EmbeddingProvider, get_embedding_provider
from core.memory.vector_store import VectorStore, QdrantVectorStore, InMemoryVectorStore
from core.memory.schemas import (
    Memory,
    MemoryFilter,
    MemoryScope,
    MemoryType,
    ScoredMemory,
    utc_now,
)
from core.memory.ranking import rank_memories
from core.memory.extraction import MemoryExtractor
from core.memory.privacy import contains_sensitive_data, redact_sensitive_data, sanitize_metadata
from core.models.gateway import ModelGateway

logger = logging.getLogger("memory")


class MemoryManager:
    def __init__(
        self,
        config: MemoryConfig | None = None,
        vector_store: VectorStore | None = None,
        embedding_provider: EmbeddingProvider | None = None,
        gateway: ModelGateway | None = None,
    ):
        self.config = config or get_memory_config()
        self.gateway = gateway

        # Initialize embedding provider
        if embedding_provider is not None:
            self.embedding_provider = embedding_provider
        else:
            try:
                self.embedding_provider = get_embedding_provider(
                    model_name=self.config.embedding_model,
                    dimension=self.config.embedding_dimension,
                )
            except Exception as e:
                logger.warning(f"[MEMORY_FAILURE] Failed to initialize embedding provider: {e}. Falling back to deterministic mock.")
                from core.memory.embeddings import DeterministicMockEmbeddingProvider
                self.embedding_provider = DeterministicMockEmbeddingProvider(self.config.embedding_dimension)

        # Initialize vector store
        if vector_store is not None:
            self.vector_store = vector_store
        else:
            try:
                self.vector_store = QdrantVectorStore(
                    url=self.config.vector_db_url,
                    collection_name=self.config.vector_collection,
                    dimension=self.embedding_provider.dimension,
                )
            except Exception as e:
                logger.warning(f"[MEMORY_FAILURE] Failed to initialize Qdrant vector store: {e}. Falling back to InMemoryVectorStore.")
                self.vector_store = InMemoryVectorStore()

        self.extractor = MemoryExtractor(gateway=self.gateway)

    def is_enabled(self) -> bool:
        return bool(self.config.enabled)

    def remember(
        self,
        content: str,
        memory_type: MemoryType = MemoryType.SEMANTIC,
        scope: MemoryScope = MemoryScope.USER,
        importance: float = 0.5,
        confidence: float = 0.8,
        tags: list[str] | None = None,
        source: str = "user_message",
        source_reference: str | None = None,
        project_id: str | None = None,
        user_id: str | None = None,
        conversation_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Memory | None:
        """
        Store a new memory or reinforce/update an existing duplicate.
        Applies privacy checks, deduplication, embedding, and vector storage.
        """
        if not self.is_enabled():
            logger.info("[MEMORY_SKIP] Memory writes are disabled by configuration.")
            return None

        clean_content = content.strip()
        if not clean_content:
            return None

        # Privacy check: reject or redact sensitive credentials
        if contains_sensitive_data(clean_content):
            logger.warning("[MEMORY_SKIP] Content contains sensitive credentials; write rejected.")
            return None

        clean_metadata = sanitize_metadata(metadata or {})

        try:
            # Generate embedding
            emb = self.embedding_provider.embed(clean_content)

            # Deduplication check: search existing memories with high similarity in the same scope
            dedup_filter = MemoryFilter(
                memory_type=memory_type,
                scope=scope,
                project_id=project_id,
                user_id=user_id,
                active_only=True,
            )
            existing_candidates = self.vector_store.search(
                query_vector=emb,
                top_k=3,
                filter=dedup_filter,
                min_similarity=self.config.dedup_threshold,
            )

            if existing_candidates:
                existing_mem, sim = existing_candidates[0]
                logger.info(
                    f"[MEMORY_DEDUP] Found similar memory (id={existing_mem.id}, sim={sim:.3f}). "
                    f"Reinforcing existing memory."
                )
                # Reinforce existing memory instead of creating duplicate
                updated = self.reinforce(
                    existing_mem.id,
                    new_content=clean_content if len(clean_content) > len(existing_mem.content) else None,
                    updated_importance=max(existing_mem.importance, importance),
                    source_reference=source_reference,
                )
                return updated

            # Create new memory record
            memory = Memory(
                content=clean_content,
                memory_type=memory_type,
                embedding=emb,
                metadata=clean_metadata,
                source=source,
                source_reference=source_reference,
                importance=min(1.0, max(0.0, importance)),
                confidence=min(1.0, max(0.0, confidence)),
                scope=scope,
                user_id=user_id,
                conversation_id=conversation_id,
                project_id=project_id,
                tags=tags or [],
                active=True,
            )

            self.vector_store.add(memory)
            logger.info(f"[MEMORY_WRITE] Successfully stored memory id={memory.id} type={memory.memory_type.value} scope={memory.scope.value}")
            return memory

        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to store memory: {e}")
            return None

    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        min_similarity: float | None = None,
        memory_type: MemoryType | None = None,
        scope: MemoryScope | None = None,
        user_id: str | None = None,
        project_id: str | None = None,
        conversation_id: str | None = None,
        active_only: bool = True,
        touch_access: bool = True,
    ) -> list[ScoredMemory]:
        """
        Retrieve relevant memories for a query, applying vector search,
        decay, and deterministic multi-factor ranking.
        """
        if not self.is_enabled():
            return []

        clean_query = query.strip()
        if not clean_query:
            return []

        limit = top_k or self.config.top_k
        min_sim = min_similarity if min_similarity is not None else self.config.similarity_threshold

        try:
            query_emb = self.embedding_provider.embed(clean_query)
            query_filter = MemoryFilter(
                memory_type=memory_type,
                scope=scope,
                user_id=user_id,
                project_id=project_id,
                conversation_id=conversation_id,
                active_only=active_only,
            )

            # Retrieve top candidates from vector store
            candidates = self.vector_store.search(
                query_vector=query_emb,
                top_k=max(limit * 2, 10),
                filter=query_filter,
                min_similarity=min_sim,
            )

            if not candidates:
                return []

            # Multi-factor ranking
            ranked = rank_memories(
                candidates=candidates,
                target_scope=scope,
                target_project_id=project_id,
                half_life_days=self.config.decay_half_life_days,
            )

            top_results = ranked[:limit]

            # Update access statistics for retrieved memories
            if touch_access:
                for sm in top_results:
                    self._touch_memory(sm.memory)

            logger.info(f"[MEMORY_RETRIEVE] Retrieved {len(top_results)} memories for query '{clean_query[:40]}...'")
            return top_results

        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to retrieve memories: {e}")
            return []

    def search(self, query: str, **kwargs) -> list[ScoredMemory]:
        return self.retrieve(query, **kwargs)

    def _touch_memory(self, memory: Memory) -> None:
        try:
            memory.last_accessed_at = utc_now()
            memory.access_count += 1
            self.vector_store.update(memory)
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Could not update access stats for memory {memory.id}: {e}")

    def reinforce(
        self,
        memory_id: str,
        new_content: str | None = None,
        updated_importance: float | None = None,
        source_reference: str | None = None,
    ) -> Memory | None:
        """Reinforce an existing memory by incrementing access count and updating content/importance."""
        try:
            mem = self.vector_store.get(memory_id)
            if not mem:
                return None

            mem.access_count += 1
            mem.last_accessed_at = utc_now()
            mem.updated_at = utc_now()

            if new_content and new_content != mem.content:
                mem.content = new_content
                mem.embedding = self.embedding_provider.embed(new_content)

            if updated_importance is not None:
                mem.importance = min(1.0, max(0.0, updated_importance))

            if source_reference:
                mem.source_reference = source_reference

            self.vector_store.update(mem)
            logger.info(f"[MEMORY_UPDATE] Reinforced memory id={mem.id}")
            return mem
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to reinforce memory {memory_id}: {e}")
            return None

    def update(self, memory: Memory) -> bool:
        """Update an existing memory."""
        try:
            if contains_sensitive_data(memory.content):
                logger.warning(f"[MEMORY_SKIP] Memory update contains sensitive data; rejected.")
                return False

            memory.updated_at = utc_now()
            if not memory.embedding:
                memory.embedding = self.embedding_provider.embed(memory.content)

            success = self.vector_store.update(memory)
            if success:
                logger.info(f"[MEMORY_UPDATE] Updated memory id={memory.id}")
            return success
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to update memory {memory.id}: {e}")
            return False

    def delete(self, memory_id: str, hard_delete: bool = False) -> bool:
        """Delete or deactivate a memory by ID."""
        try:
            success = self.vector_store.delete(memory_id, hard_delete=hard_delete)
            if success:
                logger.info(f"[MEMORY_DELETE] Deleted memory id={memory_id} (hard_delete={hard_delete})")
            return success
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to delete memory {memory_id}: {e}")
            return False

    def forget(self, query_or_content: str, threshold: float = 0.70) -> int:
        """
        Explicit forget operation: finds memories semantically matching the description
        and marks them deleted. Returns count of forgotten memories.
        """
        try:
            candidates = self.retrieve(query_or_content, top_k=10, min_similarity=threshold, touch_access=False)
            count = 0
            for sm in candidates:
                if self.delete(sm.memory.id, hard_delete=False):
                    count += 1
            logger.info(f"[MEMORY_DELETE] Explicit forget for '{query_or_content}' deactivated {count} memories.")
            return count
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed explicit forget operation: {e}")
            return 0

    def list(
        self,
        filter: MemoryFilter | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Memory]:
        """List memories matching filter criteria."""
        try:
            return self.vector_store.list(filter=filter, limit=limit, offset=offset)
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to list memories: {e}")
            return []

    def get(self, memory_id: str) -> Memory | None:
        """Retrieve memory by ID."""
        try:
            return self.vector_store.get(memory_id)
        except Exception as e:
            logger.warning(f"[MEMORY_FAILURE] Failed to get memory {memory_id}: {e}")
            return None

    def process_interaction(
        self,
        user_message: str,
        conversation_id: str | None = None,
        project_id: str | None = None,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Process a user interaction: checks explicit memory commands,
        extracts memory candidates, and stores if appropriate.
        """
        extraction = self.extractor.extract(user_message)

        if extraction.is_explicit_command:
            cmd = extraction.explicit_command_type
            if cmd == "remember" and extraction.should_store:
                mem = self.remember(
                    content=extraction.content,
                    memory_type=extraction.memory_type,
                    scope=extraction.scope,
                    importance=extraction.importance,
                    confidence=extraction.confidence,
                    tags=extraction.tags,
                    source="explicit_command",
                    conversation_id=conversation_id,
                    project_id=project_id,
                    user_id=user_id,
                )
                return {"action": "remembered", "memory": mem}

            elif cmd == "forget":
                count = self.forget(extraction.content)
                return {"action": "forgot", "count": count, "target": extraction.content}

            elif cmd == "suppress":
                logger.info("[MEMORY_SKIP] Memory suppression explicitly requested by user.")
                return {"action": "suppressed"}

            elif cmd == "query":
                memories = self.retrieve(extraction.content, top_k=5)
                return {"action": "queried", "memories": memories}

        elif extraction.should_store:
            mem = self.remember(
                content=extraction.content,
                memory_type=extraction.memory_type,
                scope=extraction.scope,
                importance=extraction.importance,
                confidence=extraction.confidence,
                tags=extraction.tags,
                source="user_message",
                conversation_id=conversation_id,
                project_id=project_id,
                user_id=user_id,
            )
            return {"action": "remembered", "memory": mem}

        return {"action": "skipped"}
