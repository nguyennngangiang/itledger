"""Domain constants shared across the repository, router and script layers.

Imports nothing on purpose. Everything else in `be/` may import this, so it has
to be a leaf — including `handover_import.py`, whose value is that it stays free
of any database dependency.

These were each declared five or six times over (repositories/device.py,
repositories/user.py, repositories/handover.py, handover_import.py, seed.py,
sync_workbook.py) with comments in each place asking the reader to keep them in
step by hand. They did stay in step; that is luck, not a design.
"""

# The ghost account that owns everything nobody is using. Mirrored on the
# frontend as GHOST_USER_CODE in fe/src/types.ts, and created by
# repositories/user.py GHOST_DDL / sql/schema.sql.
GHOST_CODE = "IT-STORE"

# Statuses that mean IT is physically holding the machine, so no person can be
# its owner. The active/in_stock pair is only auto-filled in the UI and stays
# editable; THIS one is a rule, enforced in the repository so an import or a
# direct API call cannot leave a device under repair sitting on someone's name.
IT_HELD_STATUSES = frozenset({"maintaining", "on_del"})

# GHOST_CODE is interpolated into a SQL string literal in
# repositories/handover.py (_TO_IT_SIDE, which is composed into three queries
# with different parameter counts — threading a $n through it would be worse
# code for no security gain). That is only safe while the value stays a plain
# ASCII identifier, so make the condition executable rather than a comment.
assert GHOST_CODE.isascii() and "'" not in GHOST_CODE and "\\" not in GHOST_CODE
