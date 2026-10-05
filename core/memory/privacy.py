import re
from typing import Any

# Regular expressions for common secrets, tokens, credentials, and keys
SENSITIVE_PATTERNS = [
    # API Keys & Tokens
    r"(?i)(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['\"]?([a-zA-Z0-9_\-\.]{16,})['\"]?",
    r"\bsk-[a-zA-Z0-9]{20,}\b",                # OpenAI style key
    r"\bgh[pousr]_[A-Za-z0-9_]{36,}\b",        # GitHub token
    r"\bAKIA[0-9A-Z]{16}\b",                   # AWS Access Key ID
    r"(?i)bearer\s+[a-zA-Z0-9_\-\.]{20,}",    # Bearer token
    # Passwords
    r"(?i)(?:password|passwd|pwd)\s*[:=]\s*['\"]?([^\s'\"]{6,})['\"]?",
    # Private keys
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    # Basic Auth / URLs with credentials
    r"https?:\/\/[a-zA-Z0-9_\-\.]+:[a-zA-Z0-9_\-\.]+@[a-zA-Z0-9_\-\.]+",
]

_COMPILED_PATTERNS = [re.compile(p) for p in SENSITIVE_PATTERNS]


def contains_sensitive_data(text: str) -> bool:
    """Check if the given text contains sensitive credentials, API keys, or passwords."""
    if not text:
        return False
    return any(pattern.search(text) for pattern in _COMPILED_PATTERNS)


def redact_sensitive_data(text: str) -> str:
    """Replace sensitive strings with [REDACTED]."""
    if not text:
        return text
    redacted = text
    for pattern in _COMPILED_PATTERNS:
        redacted = pattern.sub("[REDACTED_CREDENTIAL]", redacted)
    return redacted


def sanitize_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Sanitize metadata dictionary to ensure no sensitive fields or values are retained."""
    sensitive_keys = {"password", "passwd", "token", "secret", "api_key", "apikey", "auth", "credential"}
    clean = {}
    for k, v in metadata.items():
        if any(sk in k.lower() for sk in sensitive_keys):
            continue
        if isinstance(v, str):
            clean[k] = redact_sensitive_data(v)
        else:
            clean[k] = v
    return clean
