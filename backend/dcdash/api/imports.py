"""Import readings from a CSV file (w31): the import-profile routes and the import route itself. Filled in by the w31 tasks."""
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["imports"])
