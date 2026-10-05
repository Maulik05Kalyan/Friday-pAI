import sys

# Python 3.14+ compatibility: avoid upb C-extension metaclass TypeError in protobuf
if sys.version_info >= (3, 14):
    sys.modules.setdefault("google._upb._message", None)
