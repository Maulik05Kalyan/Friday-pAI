import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class MemoryConfig:
    vector_db_url: str = os.getenv("VECTOR_DB_URL", "http://localhost:6333")
    vector_collection: str = os.getenv("VECTOR_COLLECTION", "memories")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    embedding_dimension: int = int(os.getenv("EMBEDDING_DIMENSION", "384"))
    embedding_device: str = os.getenv("EMBEDDING_DEVICE", "cpu")
    similarity_metric: str = os.getenv("SIMILARITY_METRIC", "Cosine")
    top_k: int = int(os.getenv("MEMORY_TOP_K", "5"))
    similarity_threshold: float = float(os.getenv("MEMORY_SIMILARITY_THRESHOLD", "0.60"))
    dedup_threshold: float = float(os.getenv("MEMORY_DEDUP_THRESHOLD", "0.85"))
    enabled: bool = os.getenv("MEMORY_ENABLED", "true").lower() in ("true", "1", "yes")
    decay_half_life_days: float = float(os.getenv("MEMORY_DECAY_HALF_LIFE_DAYS", "30.0"))


def get_memory_config() -> MemoryConfig:
    return MemoryConfig()
