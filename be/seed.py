"""Idempotent sample-data seeder for IT Ledger.

Run inside the api container (recommended, so it can reach the `db` host):

    docker compose exec api python -m be.seed

Or from the host (uses be/.env DATABASE_URL, i.e. localhost:5432):

    python -m be.seed

Generates ~25 users, 100 devices, and related handover / maintenance
records. Uses a fixed RNG seed for reproducibility and ON CONFLICT DO
NOTHING everywhere, so re-running never creates duplicates.
"""
import asyncio
import random
from datetime import date, timedelta
from decimal import Decimal

import asyncpg

from .config import settings

N_USERS = 25
N_DEVICES = 100
N_HANDOVERS = 45
N_MAINTENANCE = 30

RNG = random.Random(20260709)  # fixed seed -> stable data across runs

# Teams mirror the hardcoded list in fe/src/types.ts (there is no teams table).
TEAMS = [
    "ESG", "DMD", "PMD", "FMD", "PROJECT", "MKT", "HR", "ACC",
    "FIN", "ADMIN", "IT", "S&P", "QA/QC", "KRDESK", "OPD",
]

# Single "ghost" account in the IT team that holds every ownerless device,
# so a device always resolves to an owner name/team and "in stock" is meaningful.
GHOST_CODE = "IT-STORE"

SURNAMES = ["Nguyen", "Tran", "Le", "Pham", "Hoang", "Vu", "Dang",
            "Bui", "Do", "Ho", "Ngo", "Duong", "Ly", "Phan", "Vo"]
MIDDLES = ["Van", "Thi", "Huu", "Duc", "Minh", "Ngoc", "Thanh",
           "Quang", "Hong", "Gia", "Thu", "Anh"]
GIVENS = ["An", "Binh", "Cuong", "Dung", "Giang", "Hanh", "Hai", "Khanh",
          "Lan", "Linh", "Mai", "Nam", "Phong", "Quan", "Son", "Tam",
          "Trang", "Tuan", "Uyen", "Vy", "Yen", "Bao", "Chi", "Duy"]

BRANDS = {
    "Dell": ["Latitude 5420", "Latitude 7440", "OptiPlex 7010", "XPS 13", "Precision 3580"],
    "HP": ["EliteBook 840", "ProBook 450", " EliteDesk 800", "ZBook Firefly", "Pavilion 15"],
    "Lenovo": ["ThinkPad X1 Carbon", "ThinkPad T14", "ThinkCentre M70", "IdeaPad 5", "Legion 5"],
    "ASUS": ["Zenbook 14", "ExpertBook B9", "Vivobook 15", "ProArt Studiobook", "TUF Gaming"],
    "Apple": ["MacBook Air M2", "MacBook Pro 14", "Mac mini M2", "iMac 24", "MacBook Pro 16"],
    "Acer": ["Aspire 5", "Swift 3", "TravelMate P4", "Veriton X", "Nitro 5"],
}
TYPES = ["Laptop", "Desktop", "Workstation", "Monitor", "Tablet"]
CPUS = ["Intel Core i5-1235U", "Intel Core i7-1360P", "Intel Core i7-13700",
        "AMD Ryzen 5 5600U", "AMD Ryzen 7 6800H", "Apple M2", "Apple M3 Pro"]
RAMS = ["8 GB", "16 GB", "32 GB", "64 GB"]
STORAGES = ["256 GB SSD", "512 GB SSD", "1 TB SSD", "2 TB SSD"]
OSES = ["Windows 11 Pro", "Windows 10 Pro", "macOS Sonoma", "Ubuntu 22.04"]
OFFICES = ["Office 365", "Office 2021", "Office 2019", "LibreOffice", None]

MX_PARTS = ["Battery", "Keyboard", "SSD", "RAM module", "Screen", "Charger",
            "Motherboard", "Fan", "Trackpad"]
MX_REASONS = ["Not powering on", "Overheating", "Slow performance",
              "Cracked screen", "Battery not holding charge", "Keyboard keys stuck",
              "Blue screen errors", "Fan making noise"]
MX_SOLUTIONS = ["Replaced part", "Cleaned and repasted", "Reinstalled OS",
                "Upgraded component", "Reseated connectors", "Firmware update"]
MX_RESULTS = ["Resolved", "Resolved", "Resolved", "Pending parts", "Escalated to vendor"]
HANDOVER_REASONS = ["New hire onboarding", "Team transfer", "Device upgrade",
                    "Replacement for faulty unit", "Role change", "Return from leave"]

TODAY = date(2026, 7, 9)


def random_date(start_days_ago: int, end_days_ago: int = 0) -> date:
    delta = RNG.randint(end_days_ago, start_days_ago)
    return TODAY - timedelta(days=delta)


def build_users() -> list[dict]:
    users = []
    for i in range(1, N_USERS + 1):
        name = f"{RNG.choice(SURNAMES)} {RNG.choice(MIDDLES)} {RNG.choice(GIVENS)}"
        users.append({
            "employee_code": f"VPHN{i:03d}",
            "name": name,
            "team": RNG.choice(TEAMS),
        })
    return users


def build_devices(users: list[dict]) -> list[dict]:
    devices = []
    for i in range(1, N_DEVICES + 1):
        brand = RNG.choice(list(BRANDS))
        model = RNG.choice(BRANDS[brand]).strip()
        # ~75% assigned to an employee; the rest sit with the ghost IT store.
        owner = RNG.choice(users)["employee_code"] if RNG.random() < 0.75 else GHOST_CODE
        # Base status follows ownership, then sprinkle repairs / pending-deletes.
        roll = RNG.random()
        if roll < 0.10:
            status = "maintaining"
        elif roll < 0.15:
            status = "on_del"
        else:
            status = "active" if owner != GHOST_CODE else "in_stock"
        devices.append({
            "serial_number": f"SN{i:06d}",
            "barcode": f"BC{RNG.randint(10**11, 10**12 - 1)}",
            "type": RNG.choice(TYPES),
            "brand": brand,
            "cpu": RNG.choice(CPUS),
            "ram": RNG.choice(RAMS),
            "storage": RNG.choice(STORAGES),
            "os": RNG.choice(OSES),
            "msoffice": RNG.choice(OFFICES),
            "buy_date": random_date(1800, 30),
            "name": f"{brand} {model}",
            "user_id": owner,
            "status": status,
        })
    return devices


def build_handovers(users: list[dict], devices: list[dict]) -> list[dict]:
    rows = []
    codes = [u["employee_code"] for u in users]
    for i in range(1, N_HANDOVERS + 1):
        device = RNG.choice(devices)
        frm = RNG.choice(codes)
        to = device["user_id"] or RNG.choice(codes)
        if to == frm:  # from and to must differ
            to = RNG.choice([c for c in codes if c != frm])
        rows.append({
            "handover_id": f"HO-{i:04d}",
            "handover_date": random_date(1200, 5),
            "device_id": device["serial_number"],
            "from_user_id": frm,
            "to_user_id": to,
            "reason": RNG.choice(HANDOVER_REASONS),
        })
    return rows


def build_maintenance(devices: list[dict]) -> list[dict]:
    rows = []
    for i in range(1, N_MAINTENANCE + 1):
        device = RNG.choice(devices)
        rows.append({
            "maintenance_id": f"MX-{i:04d}",
            "maintenance_date": random_date(900, 3),
            "device_id": device["serial_number"],
            "team": "IT",
            "part": RNG.choice(MX_PARTS),
            "reason": RNG.choice(MX_REASONS),
            "solution": RNG.choice(MX_SOLUTIONS),
            "result": RNG.choice(MX_RESULTS),
            "cost_vnd": Decimal(RNG.randint(0, 60) * 50_000),
            "remarks": RNG.choice(["", "Under warranty", "Recurring issue", "Vendor RMA"]),
        })
    return rows


async def seed() -> None:
    users = build_users()
    devices = build_devices(users)
    handovers = build_handovers(users, devices)
    maintenance = build_maintenance(devices)

    conn = await asyncpg.connect(dsn=settings.database_url)
    try:
        async with conn.transaction():
            # --- idempotent migration: status + soft-delete columns + ghost user ---
            await conn.execute(
                "ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(100)"
            )
            for tbl in ("devices", "maintenance", "handovers"):
                await conn.execute(
                    f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP"
                )
            await conn.execute(
                """INSERT INTO users (employee_code, name, team)
                   VALUES ($1, 'IT Store', 'IT')
                   ON CONFLICT (employee_code) DO NOTHING""",
                GHOST_CODE,
            )

            await conn.executemany(
                """INSERT INTO users (employee_code, name, team)
                   VALUES ($1, $2, $3) ON CONFLICT (employee_code) DO NOTHING""",
                [(u["employee_code"], u["name"], u["team"]) for u in users],
            )
            await conn.executemany(
                """INSERT INTO devices (serial_number, barcode, type, brand, cpu,
                       ram, storage, os, msoffice, buy_date, name, user_id, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                   ON CONFLICT (serial_number) DO NOTHING""",
                [(d["serial_number"], d["barcode"], d["type"], d["brand"], d["cpu"],
                  d["ram"], d["storage"], d["os"], d["msoffice"], d["buy_date"],
                  d["name"], d["user_id"], d["status"]) for d in devices],
            )

            # --- backfill legacy rows (e.g. devices seeded before `status`) ---
            # Order matters; each step only touches still-NULL rows, so manual
            # overrides set later via the UI are never clobbered on re-run.
            await conn.execute(
                "UPDATE devices SET user_id = $1 WHERE user_id IS NULL", GHOST_CODE
            )
            # A device with a maintenance record is currently being serviced.
            await conn.execute(
                """UPDATE devices SET status = 'maintaining'
                   WHERE status IS NULL
                     AND serial_number IN (
                         SELECT DISTINCT device_id FROM maintenance
                         WHERE device_id IS NOT NULL)"""
            )
            # A deterministic slice flagged as pending-delete (malfunctioning).
            await conn.execute(
                "UPDATE devices SET status = 'on_del' WHERE status IS NULL AND right(serial_number, 1) = '7'"
            )
            # Everything else follows ownership.
            await conn.execute(
                """UPDATE devices
                   SET status = CASE WHEN user_id = $1 THEN 'in_stock' ELSE 'active' END
                   WHERE status IS NULL""",
                GHOST_CODE,
            )
            # Mirror current ownership into the user_devices join table.
            await conn.executemany(
                """INSERT INTO user_devices (user_id, device_id)
                   VALUES ($1, $2) ON CONFLICT DO NOTHING""",
                [(d["user_id"], d["serial_number"]) for d in devices if d["user_id"]],
            )
            await conn.executemany(
                """INSERT INTO handovers (handover_id, handover_date, device_id,
                       from_user_id, to_user_id, reason)
                   VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (handover_id) DO NOTHING""",
                [(h["handover_id"], h["handover_date"], h["device_id"],
                  h["from_user_id"], h["to_user_id"], h["reason"]) for h in handovers],
            )
            await conn.executemany(
                """INSERT INTO maintenance (maintenance_id, maintenance_date, device_id,
                       team, part, reason, solution, result, cost_vnd, remarks)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                   ON CONFLICT (maintenance_id) DO NOTHING""",
                [(m["maintenance_id"], m["maintenance_date"], m["device_id"],
                  m["team"], m["part"], m["reason"], m["solution"], m["result"],
                  m["cost_vnd"], m["remarks"]) for m in maintenance],
            )

        counts = await conn.fetchrow(
            """SELECT (SELECT count(*) FROM users)       AS users,
                      (SELECT count(*) FROM devices)      AS devices,
                      (SELECT count(*) FROM handovers)    AS handovers,
                      (SELECT count(*) FROM maintenance)  AS maintenance"""
        )
        print(
            f"Seed complete. Totals now -> users={counts['users']}, "
            f"devices={counts['devices']}, handovers={counts['handovers']}, "
            f"maintenance={counts['maintenance']}"
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(seed())
