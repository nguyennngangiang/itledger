"""Response shapes shared by every paginated / ranked resource.

`DevicePage`, `UserPage`, `MaintenancePage` and `HandoverPage` were four
identical `{rows, total}` classes declared in four routers. FastAPI resolves
`Page[DeviceOut]` into its own OpenAPI schema (`Page_DeviceOut_`), which the
frontend does not care about — it hand-writes its types in fe/src/types.ts and
reads plain JSON.

`Ranked` stays a mixin rather than a generic, because each resource's ranked
class extends a *different* `XOut` and keeping the four names lets each carry its
own docstring in /docs.
"""
from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """One page of rows plus the unpaged total, for the table hook's pager."""

    rows: list[T]
    total: int


class Ranked(BaseModel):
    """Semantic-search fields layered onto a resource's Out model.

    `score` is the embedder's similarity (0–1), `document` is the exact flattened
    sentence it ranked (see be/documents.py — worth returning so the UI can show
    what actually matched), and `reason` is the LLM reranker's one-line
    justification, absent unless ?rerank=true.
    """

    score: float
    document: str
    reason: str | None = None


class ImportResult(BaseModel):
    """What a bulk import did. Same shape for every resource so the import
    modals can read each other's responses."""

    inserted: int
    skipped: int
    total: int
