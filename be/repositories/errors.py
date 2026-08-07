"""Domain errors raised by the repository layer.

Repositories raise these; routers catch them and translate to HTTP responses.
This keeps asyncpg (and SQL details) out of the HTTP layer.
"""


class DuplicateError(Exception):
    """A unique constraint was violated (e.g. serial number / barcode already exists)."""


class ForeignKeyError(Exception):
    """A referenced row does not exist (e.g. user_id points at no user)."""


class InUseError(Exception):
    """The row is still referenced by live data, so removing it would orphan it.

    Distinct from ForeignKeyError: nothing is broken yet — we are refusing up
    front (e.g. an employee who still holds devices) rather than reporting a
    constraint the database already rejected.
    """


class ProtectedError(Exception):
    """The row is structural and must not be removed (e.g. the IT-STORE ghost).

    Deleting it would break every code path that parks ownerless devices on it.
    """
