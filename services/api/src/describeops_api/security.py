from __future__ import annotations

import os
from typing import Annotated

from fastapi import Header, HTTPException, status

from .config import load_root_env


def require_api_token(authorization: Annotated[str | None, Header()] = None) -> None:
    load_root_env()
    expected = os.getenv("DESCRIBEOPS_API_TOKEN", "local-dev-token")
    if authorization != f"Bearer {expected}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid DescribeOps API token",
        )
