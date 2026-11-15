from pathlib import Path
import sys

import pytest

root = Path(__file__).resolve().parents[1]
backend = root / "services" / "backend"
sys.path[:0] = [str(backend / "src"), str(backend)]
raise SystemExit(pytest.main(["-q", "-p", "no:cacheprovider", str(root / "test")]))
