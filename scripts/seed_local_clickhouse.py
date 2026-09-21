#!/usr/bin/env python3
"""Copy the Cloud verdict database into local ClickHouse (full Live parity).

Cloud uses SharedMergeTree; local OSS uses ``python -m verdict schema apply``.
Materialized views are dropped during load so rollups are not double-written
from ad_events, then recreated.

Source: CLICKHOUSE_CLOUD_* (required once Cloud creds are moved there).
Dest:   CLICKHOUSE_* pointing at local HTTP.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

COPY_ORDER = [
    "dim_apps",
    "dim_advertisers",
    "dim_geo_device",
    # ad_events is optional — 9M rows and Cloud TLS often drops mid-stream.
    # Live console needs rollups + cases; pass --with-raw-events to include it.
    "rollup_5m",
    "rollup_1h",
    "rollup_1d",
    "runs",
    "cases",
    "case_candidates",
    "case_steps",
    "coverage_ledger",
    "case_recommendations",
    "feedback",
]

BATCH = {
    "ad_events": 100_000,
    "rollup_5m": 50_000,
    "rollup_1h": 50_000,
    "rollup_1d": 20_000,
}
DEFAULT_BATCH = 10_000


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def _client(*, cloud: bool):
    import clickhouse_connect

    if cloud:
        host = os.environ.get("CLICKHOUSE_CLOUD_HOST") or ""
        port = int(os.environ.get("CLICKHOUSE_CLOUD_PORT") or "8443")
        secure = (os.environ.get("CLICKHOUSE_CLOUD_SECURE") or "true").lower() == "true"
        user = os.environ.get("CLICKHOUSE_CLOUD_USER") or os.environ.get("CLICKHOUSE_USER") or "default"
        password = os.environ.get("CLICKHOUSE_CLOUD_PASSWORD") or ""
        database = os.environ.get("CLICKHOUSE_CLOUD_DATABASE") or os.environ.get("CLICKHOUSE_DATABASE") or "verdict"
    else:
        host = os.environ.get("CLICKHOUSE_HOST") or "localhost"
        port = int(os.environ.get("CLICKHOUSE_PORT") or "18123")
        secure = (os.environ.get("CLICKHOUSE_SECURE") or "false").lower() == "true"
        user = os.environ.get("CLICKHOUSE_USER") or "default"
        password = os.environ.get("CLICKHOUSE_PASSWORD") or ""
        database = os.environ.get("CLICKHOUSE_DATABASE") or "verdict"

    if not host:
        raise SystemExit("CLICKHOUSE_CLOUD_HOST is required to seed from Cloud")

    return (
        clickhouse_connect.get_client(
            host=host,
            port=port,
            username=user,
            password=password,
            database=database,
            secure=secure,
        ),
        database,
    )


def _is_cloud_host(host: str) -> bool:
    h = host.lower()
    return "clickhouse.cloud" in h


def _apply_schema() -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    cmd = [sys.executable, "-m", "verdict", "schema", "apply"]
    print("  running:", " ".join(cmd))
    subprocess.check_call(cmd, cwd=ROOT, env=env)


def _mv_names(dst, database: str) -> list[str]:
    rows = dst.query(
        """
        SELECT name FROM system.tables
        WHERE database = {db:String} AND engine = 'MaterializedView'
        """,
        parameters={"db": database},
    ).result_rows
    return [r[0] for r in rows]


def _table_exists(client, database: str, table: str) -> bool:
    n = client.query(
        """
        SELECT count() FROM system.tables
        WHERE database = {db:String} AND name = {t:String}
        """,
        parameters={"db": database, "t": table},
    ).first_item
    return int(n if isinstance(n, int) else list(n.values())[0]) > 0


def _count(client, database: str, table: str) -> int:
    if not _table_exists(client, database, table):
        return 0
    return int(client.command(f"SELECT count() FROM {database}.{table}"))


def _columns(client, database: str, table: str) -> list[str]:
    rows = client.query(
        """
        SELECT name FROM system.columns
        WHERE database = {db:String} AND table = {t:String}
        ORDER BY position
        """,
        parameters={"db": database, "t": table},
    ).result_rows
    return [r[0] for r in rows]


def _column_types(client, database: str, table: str) -> dict[str, str]:
    rows = client.query(
        """
        SELECT name, type FROM system.columns
        WHERE database = {db:String} AND table = {t:String}
        """,
        parameters={"db": database, "t": table},
    ).result_rows
    return {name: typ for name, typ in rows}


def _is_wall_clock(typ: str) -> bool:
    # Copy as toString so client TZ (e.g. IST) cannot shift DateTime values.
    return typ == "Date" or typ.startswith("DateTime")


def _select_list(cols: list[str], types: dict[str, str]) -> str:
    parts = []
    for name in cols:
        typ = types.get(name, "")
        if _is_wall_clock(typ):
            parts.append(f"toString({name}) AS {name}")
        else:
            parts.append(name)
    return ", ".join(parts)


def _parse_wall_clock(value, typ: str):
    """Parse toString() wall clock as UTC-aware datetime (insert must not assume local TZ)."""
    from datetime import date, datetime, timezone

    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value).strip().replace("T", " ").replace("Z", "")
    if "." in text:
        text = text.split(".", 1)[0]
    if typ == "Date" or len(text) == 10:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    return datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)

def _copy_table(src, dst, src_db: str, dst_db: str, table: str) -> None:
    if not _table_exists(src, src_db, table):
        print(f"  skip {table} (missing on source)")
        return
    if not _table_exists(dst, dst_db, table):
        print(f"  skip {table} (missing on destination)")
        return

    src_n = _count(src, src_db, table)
    dst_n = _count(dst, dst_db, table)
    if src_n == 0:
        print(f"  skip {table} (source empty)")
        return
    if dst_n >= src_n:
        print(f"  skip {table} (local {dst_n} >= source {src_n})")
        return
    if dst_n > 0:
        dst.command(f"TRUNCATE TABLE {dst_db}.{table}")
        print(f"  truncated {table}")

    cols_src = _columns(src, src_db, table)
    cols_dst = set(_columns(dst, dst_db, table))
    cols = [c for c in cols_src if c in cols_dst]
    if not cols:
        print(f"  skip {table} (no shared columns)")
        return

    types = _column_types(src, src_db, table)
    clock_idx = [i for i, c in enumerate(cols) if _is_wall_clock(types.get(c, ""))]
    col_list = _select_list(cols, types)
    batch = BATCH.get(table, DEFAULT_BATCH)
    t0 = time.time()
    copied = 0
    buf: list = []

    def _coerce(row):
        if not clock_idx:
            return row
        row = list(row)
        for i in clock_idx:
            row[i] = _parse_wall_clock(row[i], types[cols[i]])
        return row

    query = f"SELECT {col_list} FROM {src_db}.{table}"
    with src.query_rows_stream(query) as stream:
        for row in stream:
            buf.append(_coerce(row))
            if len(buf) >= batch:
                dst.insert(table, buf, column_names=cols, database=dst_db)
                copied += len(buf)
                buf.clear()
                pct = min(100.0, 100.0 * copied / src_n)
                print(f"  {table}: {copied}/{src_n} ({pct:.0f}%)", flush=True)
    if buf:
        dst.insert(table, buf, column_names=cols, database=dst_db)
        copied += len(buf)
    print(f"  {table}: {copied} rows in {time.time() - t0:.1f}s")
def main() -> None:
    _load_dotenv()
    force = "--force" in sys.argv
    with_raw = "--with-raw-events" in sys.argv
    tables = list(COPY_ORDER)
    if with_raw:
        tables.insert(3, "ad_events")

    local_host = os.environ.get("CLICKHOUSE_HOST", "localhost")
    if _is_cloud_host(local_host):
        raise SystemExit(
            "CLICKHOUSE_HOST still points at Cloud. ./start.sh should rewrite it to localhost first."
        )
    if not os.environ.get("CLICKHOUSE_CLOUD_HOST"):
        raise SystemExit("CLICKHOUSE_CLOUD_HOST is missing — cannot seed from Cloud.")

    print(f"Source: {os.environ['CLICKHOUSE_CLOUD_HOST']}", flush=True)
    print(f"Dest:   {local_host}:{os.environ.get('CLICKHOUSE_PORT', '18123')}", flush=True)

    src, src_db = _client(cloud=True)
    dst, dst_db = _client(cloud=False)
    dst.command(f"CREATE DATABASE IF NOT EXISTS {dst_db}")

    print("Applying OSS schema on local…", flush=True)
    _apply_schema()

    dst, dst_db = _client(cloud=False)

    mvs = _mv_names(dst, dst_db)
    if mvs:
        print("Dropping materialized views for load…", flush=True)
        for name in mvs:
            dst.command(f"DROP TABLE IF EXISTS {dst_db}.{name}")
            print(f"  dropped {name}", flush=True)

    if force:
        for table in tables:
            if _table_exists(dst, dst_db, table) and _count(dst, dst_db, table) > 0:
                dst.command(f"TRUNCATE TABLE {dst_db}.{table}")
                print(f"  force-truncated {table}", flush=True)

    print("Copying tables from Cloud…", flush=True)
    for table in tables:
        try:
            _copy_table(src, dst, src_db, dst_db, table)
        except Exception as exc:
            print(f"  ERROR {table}: {exc}", file=sys.stderr, flush=True)
            if table == "ad_events":
                print("  continuing without full ad_events (console uses rollups)", flush=True)
                continue
            raise

    print("Recreating materialized views…", flush=True)
    _apply_schema()

    dst, dst_db = _client(cloud=False)
    print(
        "Seed complete:",
        f"cases={_count(dst, dst_db, 'cases')}",
        f"rollup_1h={_count(dst, dst_db, 'rollup_1h')}",
        f"ad_events={_count(dst, dst_db, 'ad_events')}",
        flush=True,
    )


if __name__ == "__main__":
    main()
