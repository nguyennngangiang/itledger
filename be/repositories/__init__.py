"""Data-access layer: all SQL and transactions live here, one module per resource.

Repositories take a pool/connection and return plain dicts; they raise the domain
errors in errors.py instead of leaking asyncpg exceptions to the routers.
"""
