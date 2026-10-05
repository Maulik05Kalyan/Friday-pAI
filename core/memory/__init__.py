import sys

if sys.version_info >= (3, 14):
    sys.modules.setdefault("google._upb._message", None)

from core.memory.schemas import (
    Memory,
    MemoryType,
    MemoryScope,
    MemoryFilter,
    ScoredMemory,
    MemoryExtractionResult,
)
from core.memory.manager import MemoryManager
from core.memory.context_builder import ContextBuilder, PreparedContext
from core.memory.vector_store import VectorStore, QdrantVectorStore, InMemoryVectorStore
from core.memory.embeddings import (
    EmbeddingProvider,
    SentenceTransformerEmbeddingProvider,
    DeterministicMockEmbeddingProvider,
    get_embedding_provider,
)
from core.memory.config import MemoryConfig, get_memory_config

__all__ = [
    "Memory",
    "MemoryType",
    "MemoryScope",
    "MemoryFilter",
    "ScoredMemory",
    "MemoryExtractionResult",
    "MemoryManager",
    "ContextBuilder",
    "PreparedContext",
    "VectorStore",
    "QdrantVectorStore",
    "InMemoryVectorStore",
    "EmbeddingProvider",
    "SentenceTransformerEmbeddingProvider",
    "DeterministicMockEmbeddingProvider",
    "get_embedding_provider",
    "MemoryConfig",
    "get_memory_config",
]
