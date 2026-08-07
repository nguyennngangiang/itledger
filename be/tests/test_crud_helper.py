"""The identifier allowlist in repositories/_crud.py.

_crud interpolates table and column names into SQL because asyncpg cannot
parameterise them. These tests pin the thing that makes that safe: a bad
identifier is a ValueError at construction, which — because every Table is built
from module-level literals — means it is a module-import crash caught at
collection rather than a runtime hazard.

The four real Table specs are asserted here too, so a typo in an allowlist fails
one obvious test instead of surfacing as a mysteriously ignored sort column.
"""
import pytest

from be.repositories import _crud
from be.repositories import device as device_repo
from be.repositories import handover as handover_repo
from be.repositories import maintenance as maintenance_repo
from be.repositories import user as user_repo

SPECS = [device_repo.TABLE, user_repo.TABLE, handover_repo.TABLE, maintenance_repo.TABLE]


@pytest.mark.parametrize(
    "bad",
    [
        "devices; DROP TABLE users",
        "devices--",
        'devices" ',
        "devices'",
        "Devices",  # uppercase is not an unquoted identifier here
        "1devices",
        "",
        " devices",
        "devices ",
        "de vices",
        "d" * 64,  # past the Postgres limit
    ],
)
def test_a_bad_table_name_is_refused_at_construction(bad):
    with pytest.raises(ValueError, match="Not a safe SQL identifier"):
        _crud.Table(
            name=bad, pk="id", columns="id", sortable=frozenset({"id"}),
            default_sort="id",
        )


def test_a_bad_sortable_column_is_refused():
    with pytest.raises(ValueError, match="Not a safe SQL identifier"):
        _crud.Table(
            name="devices", pk="serial_number", columns="serial_number",
            sortable=frozenset({"serial_number", "name); DROP TABLE users --"}),
            default_sort="serial_number",
        )


def test_a_bad_column_in_the_select_list_is_refused():
    # `columns` is a comma-list, so each part has to be checked, not the whole.
    with pytest.raises(ValueError, match="Not a safe SQL identifier"):
        _crud.Table(
            name="devices", pk="serial_number",
            columns="serial_number, name, (SELECT secret FROM other)",
            sortable=frozenset({"serial_number"}), default_sort="serial_number",
        )


def test_a_default_sort_outside_the_allowlist_is_refused():
    # Otherwise the fallback for a rejected order_by would itself be unchecked.
    with pytest.raises(ValueError, match="default_sort"):
        _crud.Table(
            name="devices", pk="serial_number", columns="serial_number",
            sortable=frozenset({"serial_number"}), default_sort="buy_date",
        )


@pytest.mark.parametrize("spec", SPECS, ids=lambda s: s.name)
def test_the_real_specs_are_internally_consistent(spec):
    assert spec.pk in spec.columns.split(", ")
    assert spec.default_sort in spec.sortable
    assert spec.sortable <= set(spec.columns.split(", ")) | {spec.pk}


def test_every_spec_names_a_distinct_table():
    assert len({s.name for s in SPECS}) == len(SPECS)
