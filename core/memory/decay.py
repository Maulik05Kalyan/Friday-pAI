import math
from datetime import datetime, timezone
from core.memory.schemas import Memory


def calculate_decay_score(
    memory: Memory,
    half_life_days: float = 30.0,
    current_time: datetime | None = None,
) -> float:
    """
    Calculate retention/decay score for a memory between 0.0 and 1.0.
    Considers age, importance, access frequency, and last access time.
    High-importance memories decay much slower. Frequent accesses reinforce retention.
    """
    now = current_time or datetime.now(timezone.utc)
    
    # Ensure memory datetime has timezone
    ref_time = memory.last_accessed_at or memory.updated_at or memory.created_at
    if ref_time.tzinfo is None:
        ref_time = ref_time.replace(tzinfo=timezone.utc)

    age_seconds = max(0.0, (now - ref_time).total_seconds())
    age_days = age_seconds / 86400.0

    if half_life_days <= 0:
        half_life_days = 30.0

    # Base exponential decay
    raw_decay = math.pow(0.5, age_days / half_life_days)

    # Importance slows down decay (importance 1.0 reduces decay rate significantly)
    importance_factor = max(0.0, min(1.0, memory.importance))
    # Effective power: 0.1 for high importance, 1.0 for low importance
    decay_exponent = max(0.1, 1.0 - (importance_factor * 0.85))
    adjusted_decay = math.pow(raw_decay, decay_exponent)

    # Access frequency reinforcement (logarithmic boost)
    access_boost = min(0.3, math.log1p(max(0, memory.access_count - 1)) * 0.1)

    score = adjusted_decay + access_boost
    return max(0.0, min(1.0, score))


def calculate_recency_score(
    memory: Memory,
    current_time: datetime | None = None,
) -> float:
    """
    Calculate recency score (1.0 for brand new, decaying smoothly over days).
    """
    now = current_time or datetime.now(timezone.utc)
    ref_time = memory.created_at
    if ref_time.tzinfo is None:
        ref_time = ref_time.replace(tzinfo=timezone.utc)

    age_days = max(0.0, (now - ref_time).total_seconds()) / 86400.0
    # Half-value at ~7 days
    return 1.0 / (1.0 + (age_days / 7.0))
