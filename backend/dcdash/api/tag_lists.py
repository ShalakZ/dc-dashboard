"""Map a whole tag list at once, with a dry run and an Undo (w31). Filled in by the w31 tasks."""
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["tag-lists"])
