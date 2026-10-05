import math
from datetime import datetime
from core.memory.decay import calculate_decay_score, calculate_recency_score
from core.memory.schemas import Memory, ScoredMemory, MemoryScope


def rank_memories(
    candidates: list[tuple[Memory, float]],
    target_scope: MemoryScope | None = None,
    target_project_id: str | None = None,
    half_life_days: float = 30.0,
    current_time: datetime | None = None,
    similarity_weight: float = 0.50,
    importance_weight: float = 0.20,
    decay_weight: float = 0.15,
    access_weight: float = 0.10,
    scope_bonus_weight: float = 0.05,
) -> list[ScoredMemory]:
    """
    Ranks candidate memories using a deterministic multi-factor scoring formula:
    relevance = w_sim * similarity + w_imp * importance + w_dec * decay_score + w_acc * access_factor + w_scope * scope_bonus
    """
    scored: list[ScoredMemory] = []

    for memory, similarity in candidates:
        decay_score = calculate_decay_score(memory, half_life_days=half_life_days, current_time=current_time)
        recency_score = calculate_recency_score(memory, current_time=current_time)

        # Access factor: 0.0 to 1.0 (sublinear with log)
        access_factor = min(1.0, math.log1p(memory.access_count) / 4.0)

        # Contextual scope/project bonus
        scope_bonus = 0.0
        if target_scope and memory.scope == target_scope:
            scope_bonus += 0.5
        if target_project_id and memory.project_id == target_project_id:
            scope_bonus += 0.5

        # Weighted combination
        relevance = (
            similarity_weight * max(0.0, similarity)
            + importance_weight * memory.importance
            + decay_weight * decay_score
            + access_weight * access_factor
            + scope_bonus_weight * scope_bonus
        )

        scored.append(
            ScoredMemory(
                memory=memory,
                similarity=round(similarity, 4),
                recency_score=round(recency_score, 4),
                decay_score=round(decay_score, 4),
                relevance_score=round(relevance, 4),
            )
        )

    scored.sort(key=lambda sm: sm.relevance_score, reverse=True)
    return scored
