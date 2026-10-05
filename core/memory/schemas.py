from datetime import datetime, timezone
from enum import Enum
from typing import Any
import uuid

from pydantic import BaseModel, Field, field_serializer


class MemoryType(str, Enum):
    WORKING = "working"
    EPISODIC = "episodic"
    SEMANTIC = "semantic"
    PROCEDURAL = "procedural"


class MemoryScope(str, Enum):
    GLOBAL = "global"
    USER = "user"
    CONVERSATION = "conversation"
    PROJECT = "project"
    TASK = "task"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Memory(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    content: str
    memory_type: MemoryType
    embedding: list[float] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    source: str = "user_message"
    source_reference: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    last_accessed_at: datetime = Field(default_factory=utc_now)
    access_count: int = 1
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    scope: MemoryScope = MemoryScope.USER
    user_id: str | None = None
    conversation_id: str | None = None
    project_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    active: bool = True

    @field_serializer("created_at", "updated_at", "last_accessed_at", when_used="json")
    def serialize_dt(self, dt: datetime) -> str:
        return dt.isoformat()


class MemoryFilter(BaseModel):
    memory_type: MemoryType | None = None
    scope: MemoryScope | None = None
    user_id: str | None = None
    project_id: str | None = None
    conversation_id: str | None = None
    active_only: bool = True
    tags: list[str] | None = None


class ScoredMemory(BaseModel):
    memory: Memory
    similarity: float = 0.0
    recency_score: float = 0.0
    decay_score: float = 1.0
    relevance_score: float = 0.0


class MemoryExtractionResult(BaseModel):
    should_store: bool = False
    memory_type: MemoryType = MemoryType.SEMANTIC
    content: str = ""
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    scope: MemoryScope = MemoryScope.USER
    tags: list[str] = Field(default_factory=list)
    is_explicit_command: bool = False
    explicit_command_type: str | None = None  # e.g., "remember", "forget", "query", "suppress"
