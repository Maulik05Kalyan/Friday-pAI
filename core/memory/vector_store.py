import sys
from abc import ABC, abstractmethod
import math
from typing import Any
import logging

# Python 3.14+ compatibility: avoid upb C-extension metaclass TypeError in protobuf
if sys.version_info >= (3, 14):
    sys.modules.setdefault("google._upb._message", None)

from core.memory.config import get_memory_config
from core.memory.schemas import Memory, MemoryFilter, MemoryType, MemoryScope

logger = logging.getLogger(__name__)


class VectorStore(ABC):
    @abstractmethod
    def add(self, memory: Memory) -> str:
        """Add a memory with embedding to the vector store. Returns memory ID."""
        pass

    @abstractmethod
    def update(self, memory: Memory) -> bool:
        """Update an existing memory."""
        pass

    @abstractmethod
    def delete(self, memory_id: str, hard_delete: bool = False) -> bool:
        """Delete or deactivate a memory."""
        pass

    @abstractmethod
    def get(self, memory_id: str) -> Memory | None:
        """Retrieve a memory by ID."""
        pass

    @abstractmethod
    def search(
        self,
        query_vector: list[float],
        top_k: int = 5,
        filter: MemoryFilter | None = None,
        min_similarity: float = 0.0,
    ) -> list[tuple[Memory, float]]:
        """Search for top_k most similar memories. Returns list of (Memory, similarity_score)."""
        pass

    @abstractmethod
    def list(
        self,
        filter: MemoryFilter | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Memory]:
        """List memories matching filter."""
        pass

    @abstractmethod
    def count(self, filter: MemoryFilter | None = None) -> int:
        """Count memories matching filter."""
        pass


def _cosine_similarity(v1: list[float], v2: list[float]) -> float:
    if len(v1) != len(v2) or not v1:
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 == 0.0 or norm2 == 0.0:
        return 0.0
    return max(-1.0, min(1.0, dot / (norm1 * norm2)))


def _matches_filter(memory: Memory, f: MemoryFilter | None) -> bool:
    if f is None:
        return True
    if f.active_only and not memory.active:
        return False
    if f.memory_type is not None and memory.memory_type != f.memory_type:
        return False
    if f.scope is not None and memory.scope != f.scope:
        return False
    if f.user_id is not None and memory.user_id != f.user_id:
        return False
    if f.project_id is not None and memory.project_id != f.project_id:
        return False
    if f.conversation_id is not None and memory.conversation_id != f.conversation_id:
        return False
    if f.tags:
        if not any(tag in memory.tags for tag in f.tags):
            return False
    return True


class InMemoryVectorStore(VectorStore):
    """In-memory vector store implementation for testing and fallback."""
    def __init__(self):
        self._storage: dict[str, Memory] = {}

    def add(self, memory: Memory) -> str:
        self._storage[memory.id] = memory.model_copy(deep=True)
        return memory.id

    def update(self, memory: Memory) -> bool:
        if memory.id not in self._storage:
            return False
        self._storage[memory.id] = memory.model_copy(deep=True)
        return True

    def delete(self, memory_id: str, hard_delete: bool = False) -> bool:
        if memory_id not in self._storage:
            return False
        if hard_delete:
            del self._storage[memory_id]
        else:
            self._storage[memory_id].active = False
        return True

    def get(self, memory_id: str) -> Memory | None:
        mem = self._storage.get(memory_id)
        if mem:
            return mem.model_copy(deep=True)
        return None

    def search(
        self,
        query_vector: list[float],
        top_k: int = 5,
        filter: MemoryFilter | None = None,
        min_similarity: float = 0.0,
    ) -> list[tuple[Memory, float]]:
        candidates: list[tuple[Memory, float]] = []
        for mem in self._storage.values():
            if not _matches_filter(mem, filter):
                continue
            if not mem.embedding:
                continue
            sim = _cosine_similarity(query_vector, mem.embedding)
            if sim >= min_similarity:
                candidates.append((mem.model_copy(deep=True), sim))

        candidates.sort(key=lambda x: x[1], reverse=True)
        return candidates[:top_k]

    def list(
        self,
        filter: MemoryFilter | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Memory]:
        matches = [
            mem.model_copy(deep=True)
            for mem in self._storage.values()
            if _matches_filter(mem, filter)
        ]
        return matches[offset : offset + limit]

    def count(self, filter: MemoryFilter | None = None) -> int:
        return sum(1 for mem in self._storage.values() if _matches_filter(mem, filter))


class QdrantVectorStore(VectorStore):
    """Production vector store implementation backed by Qdrant."""
    def __init__(
        self,
        url: str | None = None,
        collection_name: str | None = None,
        dimension: int | None = None,
        client: Any = None,
    ):
        config = get_memory_config()
        self.url = url or config.vector_db_url
        self.collection_name = collection_name or config.vector_collection
        self.dimension = dimension or config.embedding_dimension

        if client is not None:
            self.client = client
        else:
            from qdrant_client import QdrantClient
            self.client = QdrantClient(url=self.url)

        self._ensure_collection()

    def _ensure_collection(self) -> None:
        from qdrant_client.http import models

        try:
            exists = self.client.collection_exists(collection_name=self.collection_name)
            if not exists:
                distance = models.Distance.COSINE
                self.client.create_collection(
                    collection_name=self.collection_name,
                    vectors_config=models.VectorParams(size=self.dimension, distance=distance),
                )
                logger.info(f"Created Qdrant collection '{self.collection_name}' with dim {self.dimension}.")
            else:
                info = self.client.get_collection(collection_name=self.collection_name)
                # Handle vector size check if available
                vec_config = info.config.params.vectors
                if hasattr(vec_config, "size") and vec_config.size != self.dimension:
                    raise ValueError(
                        f"Collection '{self.collection_name}' dimension mismatch: "
                        f"expected {self.dimension}, found {vec_config.size}"
                    )
        except Exception as e:
            logger.warning(f"Error ensuring Qdrant collection: {e}")
            raise

    def _build_filter(self, f: MemoryFilter | None) -> Any:
        from qdrant_client.http import models

        if not f:
            return models.Filter(must=[models.FieldCondition(key="active", match=models.MatchValue(value=True))])

        must_conditions: list[Any] = []
        if f.active_only:
            must_conditions.append(models.FieldCondition(key="active", match=models.MatchValue(value=True)))
        if f.memory_type is not None:
            must_conditions.append(models.FieldCondition(key="memory_type", match=models.MatchValue(value=f.memory_type.value)))
        if f.scope is not None:
            must_conditions.append(models.FieldCondition(key="scope", match=models.MatchValue(value=f.scope.value)))
        if f.user_id is not None:
            must_conditions.append(models.FieldCondition(key="user_id", match=models.MatchValue(value=f.user_id)))
        if f.project_id is not None:
            must_conditions.append(models.FieldCondition(key="project_id", match=models.MatchValue(value=f.project_id)))
        if f.conversation_id is not None:
            must_conditions.append(models.FieldCondition(key="conversation_id", match=models.MatchValue(value=f.conversation_id)))
        if f.tags:
            must_conditions.append(models.FieldCondition(key="tags", match=models.MatchAny(any=f.tags)))

        if not must_conditions:
            return None
        return models.Filter(must=must_conditions)

    def _payload_to_memory(self, payload: dict[str, Any], vector: list[float] | None = None) -> Memory:
        data = dict(payload)
        if vector is not None:
            data["embedding"] = vector
        return Memory.model_validate(data)

    def add(self, memory: Memory) -> str:
        from qdrant_client.http import models

        if not memory.embedding:
            raise ValueError("Cannot add memory without embedding to vector store.")

        if len(memory.embedding) != self.dimension:
            raise ValueError(
                f"Embedding dimension mismatch: expected {self.dimension}, got {len(memory.embedding)}"
            )

        payload = memory.model_dump(mode="json", exclude={"embedding"})
        point = models.PointStruct(
            id=memory.id,
            vector=memory.embedding,
            payload=payload,
        )
        self.client.upsert(
            collection_name=self.collection_name,
            points=[point],
        )
        return memory.id

    def update(self, memory: Memory) -> bool:
        from qdrant_client.http import models

        # Check existence
        existing = self.get(memory.id)
        if existing is None:
            return False

        vector = memory.embedding if memory.embedding else existing.embedding
        if vector and len(vector) != self.dimension:
            raise ValueError(
                f"Embedding dimension mismatch: expected {self.dimension}, got {len(vector)}"
            )

        payload = memory.model_dump(mode="json", exclude={"embedding"})
        point = models.PointStruct(
            id=memory.id,
            vector=vector or [0.0] * self.dimension,
            payload=payload,
        )
        self.client.upsert(
            collection_name=self.collection_name,
            points=[point],
        )
        return True

    def delete(self, memory_id: str, hard_delete: bool = False) -> bool:
        from qdrant_client.http import models

        existing = self.get(memory_id)
        if existing is None:
            return False

        if hard_delete:
            self.client.delete(
                collection_name=self.collection_name,
                points_selector=models.PointIdsList(points=[memory_id]),
            )
        else:
            existing.active = False
            self.update(existing)
        return True

    def get(self, memory_id: str) -> Memory | None:
        try:
            records = self.client.retrieve(
                collection_name=self.collection_name,
                ids=[memory_id],
                with_vectors=True,
                with_payload=True,
            )
            if not records:
                return None
            rec = records[0]
            vector = None
            if rec.vector is not None:
                if isinstance(rec.vector, list):
                    vector = [float(x) for x in rec.vector]
                elif hasattr(rec.vector, "values"):
                    vector = [float(x) for x in rec.vector.values]
            return self._payload_to_memory(rec.payload or {}, vector=vector)
        except Exception as e:
            logger.warning(f"Error retrieving memory '{memory_id}' from Qdrant: {e}")
            return None

    def search(
        self,
        query_vector: list[float],
        top_k: int = 5,
        filter: MemoryFilter | None = None,
        min_similarity: float = 0.0,
    ) -> list[tuple[Memory, float]]:
        if len(query_vector) != self.dimension:
            raise ValueError(
                f"Query vector dimension mismatch: expected {self.dimension}, got {len(query_vector)}"
            )

        qdrant_filter = self._build_filter(filter)
        if hasattr(self.client, "query_points"):
            res = self.client.query_points(
                collection_name=self.collection_name,
                query=query_vector,
                limit=top_k,
                query_filter=qdrant_filter,
                score_threshold=min_similarity if min_similarity > 0 else None,
                with_payload=True,
                with_vectors=True,
            )
            results = res.points
        else:
            results = self.client.search(
                collection_name=self.collection_name,
                query_vector=query_vector,
                limit=top_k,
                query_filter=qdrant_filter,
                score_threshold=min_similarity if min_similarity > 0 else None,
                with_payload=True,
                with_vectors=True,
            )

        scored: list[tuple[Memory, float]] = []
        for hit in results:
            vector = None
            if hit.vector is not None:
                if isinstance(hit.vector, list):
                    vector = [float(x) for x in hit.vector]
                elif hasattr(hit.vector, "values"):
                    vector = [float(x) for x in hit.vector.values]
            mem = self._payload_to_memory(hit.payload or {}, vector=vector)
            scored.append((mem, float(hit.score)))
        return scored

    def list(
        self,
        filter: MemoryFilter | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Memory]:
        qdrant_filter = self._build_filter(filter)
        records, _ = self.client.scroll(
            collection_name=self.collection_name,
            scroll_filter=qdrant_filter,
            limit=limit,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        memories = []
        for rec in records:
            vector = None
            if rec.vector is not None:
                if isinstance(rec.vector, list):
                    vector = [float(x) for x in rec.vector]
                elif hasattr(rec.vector, "values"):
                    vector = [float(x) for x in rec.vector.values]
            memories.append(self._payload_to_memory(rec.payload or {}, vector=vector))
        return memories

    def count(self, filter: MemoryFilter | None = None) -> int:
        qdrant_filter = self._build_filter(filter)
        res = self.client.count(
            collection_name=self.collection_name,
            count_filter=qdrant_filter,
            exact=True,
        )
        return int(res.count)
