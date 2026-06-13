from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


@lru_cache(maxsize=1)
def load_root_env() -> Path | None:
    """Load the nearest project .env without overriding exported variables."""
    for directory in [Path.cwd(), *Path.cwd().parents]:
        env_path = directory / ".env"
        if env_path.is_file():
            load_dotenv(env_path, override=False)
            return env_path
    return None
