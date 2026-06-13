"""Domain errors raised by the repository layer.

Repositories raise these; routers catch them and translate to HTTP responses.
This keeps asyncpg (and SQL details) out of the HTTP layer.
"""


class DuplicateError(Exception):
    """A unique constraint was violated (e.g. serial number / barcode already exists)."""


class ForeignKeyError(Exception):
    """A referenced row does not exist (e.g. user_id points at no user)."""
