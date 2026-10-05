import json
import re
import logging
from typing import Any

from core.models.gateway import ModelGateway
from core.memory.schemas import MemoryExtractionResult, MemoryType, MemoryScope
from core.memory.privacy import contains_sensitive_data, redact_sensitive_data

logger = logging.getLogger(__name__)

# Explicit command patterns
REMEMBER_PATTERNS = [
    re.compile(r"^(?:please\s+)?remember\s+that\s+(.*)$", re.IGNORECASE),
    re.compile(r"^(?:please\s+)?remember(?:\s*:\s*|\s+)(.*)$", re.IGNORECASE),
    re.compile(r"^keep\s+in\s+mind\s+that\s+(.*)$", re.IGNORECASE),
]

FORGET_PATTERNS = [
    re.compile(r"^(?:please\s+)?forget\s+that\s+(.*)$", re.IGNORECASE),
    re.compile(r"^(?:please\s+)?forget\s+about\s+(.*)$", re.IGNORECASE),
    re.compile(r"^(?:please\s+)?forget(?:\s*:\s*|\s+)(.*)$", re.IGNORECASE),
    re.compile(r"^delete\s+memory(?:\s*:\s*|\s+about\s+)(.*)$", re.IGNORECASE),
]

SUPPRESS_PATTERNS = [
    re.compile(r"^don'?t\s+remember\s+(?:this|that)", re.IGNORECASE),
    re.compile(r"^do\s+not\s+remember\s+(?:this|that)", re.IGNORECASE),
]

QUERY_PATTERNS = [
    re.compile(r"^(?:show|tell)\s+me\s+what\s+you\s+remember\s+about\s+(.*)$", re.IGNORECASE),
    re.compile(r"^what\s+do\s+you\s+remember\s+about\s+(.*)$", re.IGNORECASE),
    re.compile(r"^what\s+are\s+your\s+memories\s+about\s+(.*)$", re.IGNORECASE),
]

# Low value messages that should never be stored
LOW_VALUE_PATTERNS = [
    re.compile(r"^(?:hi|hello|hey|greetings|howdy|good\s+(?:morning|afternoon|evening))\b", re.IGNORECASE),
    re.compile(r"^(?:thanks|thank\s+you|ok|okay|cool|awesome|bye|goodbye|exit|quit)$", re.IGNORECASE),
    re.compile(r"^(?:what\s+is|who\s+is|define|calculate|explain|how\s+do\s+I)\b(?!\s+(?:my|our|we))", re.IGNORECASE),
]

EXTRACTION_SYSTEM_PROMPT = """
You are the memory extraction component of a personal AI assistant.

Your task is to analyze the user's message and determine whether it contains facts, preferences, workflows, or events that should be saved to persistent memory for future interactions.

Memory Categories:
- semantic: Stable facts/preferences/knowledge about the user or their environment (e.g. "I use Ubuntu", "My name is Alice", "I prefer pytest").
- episodic: Past interactions, completed tasks, major decisions (e.g. "We decided to migrate to Python 3.14").
- procedural: Reusable procedures, workflows, instructions for doing something (e.g. "To deploy, always run test then build").
- working: Short-lived context (never persist as permanent memory).

Do NOT store:
- Casual conversation, greetings, simple questions, temporary calculations, transient requests.
- Sensitive information, passwords, secrets, API keys.

Return ONLY a valid JSON object with this exact structure:
{
  "should_store": true | false,
  "memory_type": "semantic" | "episodic" | "procedural",
  "content": "A concise, objective summary of the memory",
  "importance": 0.0 - 1.0,
  "confidence": 0.0 - 1.0,
  "scope": "global" | "user" | "project",
  "tags": ["tag1", "tag2"]
}

If nothing is worth storing, return:
{
  "should_store": false,
  "memory_type": "semantic",
  "content": "",
  "importance": 0.0,
  "confidence": 0.0,
  "scope": "user",
  "tags": []
}

Do not include markdown or reasoning. Output JSON only.
"""


class MemoryExtractor:
    def __init__(self, gateway: ModelGateway | None = None):
        self.gateway = gateway

    def parse_explicit_command(self, text: str) -> MemoryExtractionResult | None:
        stripped = text.strip()

        # Check suppression
        for pattern in SUPPRESS_PATTERNS:
            if pattern.search(stripped):
                return MemoryExtractionResult(
                    should_store=False,
                    is_explicit_command=True,
                    explicit_command_type="suppress",
                )

        # Check explicit remember
        for pattern in REMEMBER_PATTERNS:
            m = pattern.search(stripped)
            if m:
                fact = m.group(1).strip()
                # Check for sensitive content
                if contains_sensitive_data(fact):
                    logger.warning("Explicit remember command rejected: contains sensitive data.")
                    return MemoryExtractionResult(
                        should_store=False,
                        is_explicit_command=True,
                        explicit_command_type="remember",
                        content="Rejected due to sensitive credentials.",
                    )

                # Procedural if contains 'how to', 'when ... always', 'steps'
                mtype = MemoryType.SEMANTIC
                if any(w in fact.lower() for w in ["how to", "always run", "procedure", "steps to"]):
                    mtype = MemoryType.PROCEDURAL

                return MemoryExtractionResult(
                    should_store=True,
                    memory_type=mtype,
                    content=fact,
                    importance=0.9,
                    confidence=1.0,
                    scope=MemoryScope.USER,
                    tags=["explicit", "preference"],
                    is_explicit_command=True,
                    explicit_command_type="remember",
                )

        # Check explicit forget
        for pattern in FORGET_PATTERNS:
            m = pattern.search(stripped)
            if m:
                target = m.group(1).strip()
                return MemoryExtractionResult(
                    should_store=False,
                    is_explicit_command=True,
                    explicit_command_type="forget",
                    content=target,
                )

        # Check explicit query
        for pattern in QUERY_PATTERNS:
            m = pattern.search(stripped)
            if m:
                topic = m.group(1).strip()
                return MemoryExtractionResult(
                    should_store=False,
                    is_explicit_command=True,
                    explicit_command_type="query",
                    content=topic,
                )

        return None

    def is_low_value(self, text: str) -> bool:
        stripped = text.strip()
        if len(stripped) < 4:
            return True
        for pattern in LOW_VALUE_PATTERNS:
            if pattern.search(stripped):
                # Ensure no user signals like "my preferred"
                if not any(signal in stripped.lower() for signal in [" my ", " i use ", " i prefer ", " we decided "]):
                    return True
        return False

    def extract(
        self,
        user_message: str,
        conversation_context: list[dict[str, str]] | None = None,
    ) -> MemoryExtractionResult:
        """
        Extract memory candidates from a user interaction.
        Validates output deterministically with Pydantic.
        """
        if not user_message:
            return MemoryExtractionResult(should_store=False)

        # 1. Check explicit commands first
        cmd = self.parse_explicit_command(user_message)
        if cmd is not None:
            return cmd

        # 2. Check for sensitive credentials
        if contains_sensitive_data(user_message):
            logger.warning("Message contains sensitive data; suppressing automatic memory extraction.")
            return MemoryExtractionResult(should_store=False)

        # 3. Check low value heuristics
        if self.is_low_value(user_message):
            return MemoryExtractionResult(should_store=False)

        # 4. Use LLM if gateway is provided
        if self.gateway is not None:
            try:
                messages = [
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": f"User interaction: {user_message}"},
                ]
                resp = self.gateway.generate(messages, temperature=0.0, max_tokens=500)
                content = resp.content.strip()
                # Parse JSON
                data = json.loads(content)
                result = MemoryExtractionResult.model_validate(data)

                # Ensure sensitive data is not kept
                if contains_sensitive_data(result.content):
                    logger.warning("Extracted memory content contained sensitive data; dropped.")
                    return MemoryExtractionResult(should_store=False)

                return result
            except Exception as e:
                logger.warning(f"LLM memory extraction failed or returned invalid format: {e}")
                # Fallback to rule-based heuristic extraction

        # 5. Rule-based heuristic extraction fallback
        return self._heuristic_extract(user_message)

    def _heuristic_extract(self, text: str) -> MemoryExtractionResult:
        lower = text.lower()
        # Semantic signals: user preferences / environment
        semantic_signals = ["i prefer ", "my name is ", "i work on ", "i use ", "my environment is "]
        for s in semantic_signals:
            if s in lower:
                return MemoryExtractionResult(
                    should_store=True,
                    memory_type=MemoryType.SEMANTIC,
                    content=text.strip(),
                    importance=0.7,
                    confidence=0.85,
                    scope=MemoryScope.USER,
                    tags=["preference"],
                )

        # Procedural signals
        procedural_signals = ["always do ", "the procedure is ", "steps to follow:"]
        for p in procedural_signals:
            if p in lower:
                return MemoryExtractionResult(
                    should_store=True,
                    memory_type=MemoryType.PROCEDURAL,
                    content=text.strip(),
                    importance=0.8,
                    confidence=0.85,
                    scope=MemoryScope.USER,
                    tags=["procedure"],
                )

        return MemoryExtractionResult(should_store=False)
