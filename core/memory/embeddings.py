from abc import ABC, abstractmethod
import hashlib
import math
from typing import ClassVar

from core.memory.config import get_memory_config


class EmbeddingProvider(ABC):
    @property
    @abstractmethod
    def dimension(self) -> int:
        """The output dimension of the embeddings."""
        pass

    @abstractmethod
    def embed(self, text: str) -> list[float]:
        """Embed a single string."""
        pass

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of strings."""
        pass


class SentenceTransformerEmbeddingProvider(EmbeddingProvider):
    _instances: ClassVar[dict[str, "SentenceTransformerEmbeddingProvider"]] = {}

    def __init__(self, model_name: str | None = None, device: str | None = None):
        config = get_memory_config()
        self.model_name = model_name or config.embedding_model
        self.device = device or config.embedding_device
        try:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name, device=self.device)
            # Infer dimension
            test_emb = self._model.encode("test", convert_to_numpy=True)
            self._dim = int(len(test_emb))
        except Exception as e:
            raise RuntimeError(f"Failed to load embedding model '{self.model_name}' on device '{self.device}': {e}") from e

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, text: str) -> list[float]:
        if not text:
            return [0.0] * self._dim
        emb = self._model.encode(text, convert_to_numpy=True, normalize_embeddings=True)
        return [float(x) for x in emb]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        embs = self._model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
        return [[float(x) for x in row] for row in embs]


class DeterministicMockEmbeddingProvider(EmbeddingProvider):
    """
    Deterministic pseudo-embedding provider for testing.
    Computes a normalized float vector of specified dimension using text hashing.
    """
    def __init__(self, dimension: int = 384):
        self._dim = dimension

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, text: str) -> list[float]:
        if not text:
            return [0.0] * self._dim

        # Create deterministic vector via SHA256 hashing slices
        vec = []
        for i in range(self._dim):
            token = f"{text}_{i}".encode("utf-8")
            h = int(hashlib.sha256(token).hexdigest()[:8], 16)
            # Center around 0
            val = (h / 0xFFFFFFFF) * 2.0 - 1.0
            vec.append(val)

        # Normalize to unit length
        norm = math.sqrt(sum(x * x for x in vec))
        if norm > 0:
            vec = [x / norm for x in vec]
        return vec

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(t) for t in texts]


def get_embedding_provider(
    model_name: str | None = None,
    use_mock: bool = False,
    dimension: int | None = None,
) -> EmbeddingProvider:
    config = get_memory_config()
    if use_mock:
        return DeterministicMockEmbeddingProvider(dimension or config.embedding_dimension)

    target_model = model_name or config.embedding_model
    try:
        return SentenceTransformerEmbeddingProvider(target_model)
    except Exception:
        # Fallback to mock if sentence_transformers cannot load
        return DeterministicMockEmbeddingProvider(dimension or config.embedding_dimension)
