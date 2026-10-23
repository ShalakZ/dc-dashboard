"""Map by tag shape (w36): read-only routes that group a source's points into shapes and turn decisions about shapes into tag-list
lines. They write nothing; every mapping is written by the tag-list route (api/tag_lists.py)."""
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["shapes"])
