import sys

# Ensure Python 3.14+ protobuf compatibility across all pytest runners
if sys.version_info >= (3, 14):
    sys.modules.setdefault("google._upb._message", None)
