"""
Planner — M5.5: Memory-Aware Intent & Operations.

Key changes:
- Strongly typed intent taxonomy replaces free-form intent string.
- Knowledge vs. memory semantics are explicitly separated in the prompt.
- Robust structured-output parsing: handles <think> blocks, surrounding
  text, JSON comments, and multiple JSON objects safely.
- Deterministic Pydantic validation enforces the semantic contract after
  LLM output is parsed.
"""
import json
import logging
import re

from core.models.gateway import ModelGateway
from core.orchestrator.schemas import TaskPlan

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """
You are the planning component of a personal AI operating system.

You do NOT directly answer the user's request.

Your job is to understand what the user is trying to accomplish
and create a minimal, executable plan expressed as structured JSON.

═══════════════════════════════════════════════════════════════════════
INTENT TAXONOMY
═══════════════════════════════════════════════════════════════════════

You must classify the user's intent as exactly one of:

  knowledge_query
    The user wants general or world knowledge that does not depend on
    anything previously stored about them specifically.
    Examples:
      "What is Linux?"
      "How does TCP/IP work?"
      "Explain gradient descent."

  memory_query
    The user is asking about something specific to themselves — their
    preferences, past decisions, project state, or personal history.
    The answer MUST come from persistent user memory, not world knowledge.
    Examples:
      "What OS do I like to work on?"
      "What was the project name we agreed on?"
      "What are my coding preferences?"

  memory_write
    The user is explicitly instructing the system to remember a fact,
    preference, event, or workflow for future interactions.
    Examples:
      "Remember that I like to work on Linux."
      "Keep in mind that I use Python 3.12."

  memory_forget
    The user is instructing the system to forget or delete a previously
    stored memory.
    Examples:
      "Forget that I like Linux."
      "Please forget about my old project."

  memory_suppress
    The user is instructing the system NOT to store information from
    the current interaction.
    Examples:
      "Don't remember this conversation."
      "Do not store what I'm about to say."

  tool_action
    The user wants to invoke an external capability (web, calendar, etc.).
    Currently NO external tools are available. Use this if the request
    clearly requires an unavailable external tool.

  workflow
    The user wants a multi-step orchestrated task spanning multiple
    capability types.

  conversation
    Purely conversational; no action or retrieval required.
    Examples:
      "Hello"
      "Thanks"

═══════════════════════════════════════════════════════════════════════
CRITICAL SEMANTIC RULES — READ CAREFULLY
═══════════════════════════════════════════════════════════════════════

KNOWLEDGE vs. MEMORY — These are fundamentally different:

  "knowledge" capability = general world knowledge already in the model.
    Use ONLY for questions about the world that do not depend on
    user-specific information.

  "memory" capability = user-specific persistent information.
    Use when the answer depends on facts stored specifically about
    this user: preferences, decisions, projects, history.

THE FOLLOWING RULES ARE ABSOLUTE:

  1. Personal facts MUST come from memory.
     Do NOT answer personal questions from general knowledge.
     Do NOT fabricate personal facts because they seem plausible.

  2. User preferences MUST come from memory.
     Example: "What OS do I like?" → memory.retrieve, NOT knowledge.

  3. Previous decisions and conversations MUST come from memory when relevant.

  4. General world knowledge questions MUST use knowledge capability.
     Example: "What is Linux?" → knowledge, NOT memory.

  5. If memory is unavailable or returns nothing, the system MUST
     explicitly represent uncertainty rather than inventing an answer.

  6. The "knowledge" capability MUST NOT be used as a substitute for
     retrieving user-specific facts.

  7. memory_query intent REQUIRES at least one memory step with
     memory_operation = "retrieve".

  8. memory_write intent REQUIRES at least one memory step with
     memory_operation = "store".

  9. memory_forget intent REQUIRES at least one memory step with
     memory_operation = "forget".

  10. knowledge_query intent MUST NOT include a memory retrieval step
      unless there is a clear and explicit reason the user's personal
      context is needed to answer the question.

═══════════════════════════════════════════════════════════════════════
AVAILABLE CAPABILITIES
═══════════════════════════════════════════════════════════════════════

  knowledge
    Answers questions using the model's general/world knowledge.
    memory_operation must be "none" for knowledge steps.

  memory
    Performs memory operations. MUST specify memory_operation:
      "retrieve" — query and return relevant stored user memories.
      "store"    — persist a user fact or preference.
      "forget"   — deactivate memories matching a description.
      "suppress" — prevent storage of this interaction.

Currently unavailable (do NOT use):
  web, filesystem, python, email, calendar, database,
  external APIs, code execution, shell, github, notifications

═══════════════════════════════════════════════════════════════════════
PLANNING RULES
═══════════════════════════════════════════════════════════════════════

  - Use only capabilities listed above.
  - Create minimal steps. Avoid unnecessary steps.
  - Do not create steps for internal reasoning alone.
  - Simple questions typically need exactly one step.
  - Do not describe the final answer as a step.
  - Do not invent capabilities, tools, or databases.

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — RETURN ONLY VALID JSON, NO MARKDOWN, NO COMMENTS
═══════════════════════════════════════════════════════════════════════

{
  "goal": "string",
  "intent": "knowledge_query | memory_query | memory_write | memory_forget | memory_suppress | tool_action | workflow | conversation",
  "complexity": "simple | medium | complex",
  "assumptions": [],
  "requires_memory": false,
  "requires_tools": false,
  "steps": [
    {
      "id": "step_1",
      "capability": "knowledge | memory",
      "memory_operation": "none | retrieve | store | forget | suppress",
      "purpose": "string",
      "depends_on": []
    }
  ]
}

FIELD RULES:
  - intent: must be exactly one of the values in the taxonomy above.
  - complexity: exactly "simple", "medium", or "complex".
  - capability: exactly "knowledge" or "memory".
  - memory_operation: "none" for knowledge steps.
                      "retrieve", "store", "forget", or "suppress" for memory steps.
  - requires_memory: true when the plan contains memory steps.
  - requires_tools: false (no external tools available).
  - depends_on: contains only step IDs from this plan.

EXAMPLES:

  Input:  "Remember that I like to work on Linux."
  Output: intent=memory_write, step with capability=memory, memory_operation=store

  Input:  "What OS do I like to work on?"
  Output: intent=memory_query, step with capability=memory, memory_operation=retrieve

  Input:  "Forget that I like Linux."
  Output: intent=memory_forget, step with capability=memory, memory_operation=forget

  Input:  "Don't remember this conversation."
  Output: intent=memory_suppress, step with capability=memory, memory_operation=suppress

  Input:  "What is Linux?"
  Output: intent=knowledge_query, step with capability=knowledge, memory_operation=none

  Input:  "How does TCP/IP work?"
  Output: intent=knowledge_query, step with capability=knowledge, memory_operation=none

Do not use Markdown.
Do not use code fences.
Do not include <think> or any reasoning in the JSON.
Do not add comments inside JSON.
Return JSON only.
"""


# ---------------------------------------------------------------------------
# Structured-output extraction
# ---------------------------------------------------------------------------

# Matches a JSON object (non-greedy, handles nesting naively via rfind).
_JSON_OBJECT_RE = re.compile(r"\{", re.DOTALL)


def _extract_json(text: str) -> str:
    """
    Robustly extract the first valid JSON object from potentially messy
    LLM output that may contain:
      - <think>...</think> blocks (already stripped by ModelGateway)
      - Surrounding prose / markdown
      - JSON comments (// or /* */ style) — stripped before parsing
      - Multiple JSON objects (use first valid one)
      - Trailing commas before } or ]

    Raises ValueError if no valid JSON object can be extracted.
    Does NOT silently guess at malformed content.
    """
    # Strip JSON-style comments (// line comments, /* block comments */)
    text = _strip_json_comments(text)

    # Find the first '{' — start of the JSON object
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in LLM output.")

    # Walk forward to find the matching closing brace
    depth = 0
    in_string = False
    escape_next = False
    end = -1

    for i, ch in enumerate(text[start:], start=start):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"' and not escape_next:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    if end == -1:
        raise ValueError("Incomplete JSON object in LLM output (unmatched braces).")

    candidate = text[start : end + 1]

    # Fix common trailing-comma issues (e.g. [1, 2,] or {a: 1,})
    candidate = re.sub(r",\s*([\]}])", r"\1", candidate)

    return candidate


def _strip_json_comments(text: str) -> str:
    """Strip // line comments and /* block */ comments from JSON-like text."""
    # Block comments
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    # Line comments (// ...) — only outside strings (approximation)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def _safe_parse(raw: str) -> dict:
    """
    Parse LLM output into a dict safely.
    Raises ValueError with a descriptive message on any parse failure.
    Never silently converts invalid output into a guessed plan.
    """
    raw = raw.strip()
    if not raw:
        raise ValueError("LLM returned empty output.")

    try:
        candidate = _extract_json(raw)
    except ValueError as exc:
        raise ValueError(f"JSON extraction failed: {exc}") from exc

    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"JSON parse error after extraction: {exc}\n"
            f"Extracted candidate:\n{candidate[:500]}"
        ) from exc


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


class Planner:
    def __init__(self, gateway: ModelGateway):
        self.gateway = gateway

    def create_plan(self, user_message: str, context: str | None = None) -> TaskPlan:
        prompt_content = context if context is not None else user_message

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt_content},
        ]

        response = self.gateway.generate(
            messages,
            temperature=0.0,
            max_tokens=1200,
        )

        logger.debug("MODEL REASONING: %s", response.reasoning)
        logger.debug("MODEL OUTPUT: %s", response.content)

        print("\nMODEL REASONING:")
        print(response.reasoning)
        print("\nMODEL OUTPUT:")
        print(response.content)

        data = _safe_parse(response.content)
        plan = TaskPlan.model_validate(data)
        return plan

    def replan(
        self,
        user_message: str,
        previous_plan: TaskPlan,
        observation: str,
    ) -> TaskPlan:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"""
Original user request:

{user_message}

Previous plan:

{previous_plan.model_dump_json(indent=2)}

Execution observation:

{observation}

The previous execution did not successfully complete the user's request.

Create a new minimal plan that addresses the failure.

Do not repeat the exact same failed approach unless
the observation indicates that it can succeed.

Return ONLY valid JSON.
""",
            },
        ]

        response = self.gateway.generate(
            messages,
            temperature=0.0,
            max_tokens=1200,
        )

        logger.debug("REPLAN MODEL REASONING: %s", response.reasoning)
        logger.debug("REPLAN MODEL OUTPUT: %s", response.content)

        print("\nREPLAN MODEL REASONING:")
        print(response.reasoning)
        print("\nREPLAN MODEL OUTPUT:")
        print(response.content)

        data = _safe_parse(response.content)
        return TaskPlan.model_validate(data)