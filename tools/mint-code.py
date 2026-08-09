"""Put a fresh invite code on a pending invite, and print it once.

WHY THIS EXISTS. Codes are normally minted inside the `invite` edge function, which needs a signed-in
caller. That is a chicken-and-egg the first time: invites written before the code column existed have
a null `code_hash` and can never be redeemed, and nobody can call `invite` until somebody can sign in.
This writes the hash directly, for exactly that case.

It is not the everyday path. Once you can sign in, invite people from the Admin view — that route
enforces the project's member ceiling and records who did the inviting, and this one does neither.

    python3 tools/mint-code.py ashley@example.com
    python3 tools/mint-code.py ashley@example.com --create   # if no pending invite exists yet

The plaintext is printed once and never stored; the row gets its SHA-256. Losing it means running
this again, which is the intended repair and why nothing tries to read a code back.
"""

import argparse
import hashlib
import os
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Must match supabase/functions/_shared/code.ts. Digits 2-9 and A-Z without I, L or O — the pairs a
# person confuses reading a code off a screen.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LENGTH = 12

# The project every pre-accounts row was attached to. Only used with --create.
DEFAULT_PROJECT = "00000000-0000-4000-a000-000000000001"


def env() -> dict[str, str]:
    """Read .env without exporting it into anything that might log it."""
    values: dict[str, str] = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    missing = [k for k in ("SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD") if k not in values]
    if missing:
        sys.exit(f"mint-code: .env is missing {', '.join(missing)}")
    return values


def psql(sql: str, settings: dict[str, str]) -> str:
    result = subprocess.run(
        [
            "psql",
            "-h", "aws-1-eu-west-1.pooler.supabase.com",
            "-p", "5432",
            "-U", f"postgres.{settings['SUPABASE_PROJECT_REF']}",
            "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            "-tAc", sql,
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PGPASSWORD": settings["SUPABASE_DB_PASSWORD"]},
    )
    if result.returncode != 0:
        sys.exit(f"mint-code: psql failed\n{result.stderr.strip()}")
    return result.stdout.strip()


def generate() -> str:
    """`secrets.choice` is already unbiased, so there is no rejection sampling to mirror here —
    the TypeScript version needs it only because it draws raw bytes."""
    return "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("email")
    parser.add_argument("--create", action="store_true", help="write a pending invite if none exists")
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    args = parser.parse_args()

    email = args.email.strip().lower()
    settings = env()

    existing = psql(
        f"select id from invite where lower(email) = '{email}' and status = 'pending' limit 1;",
        settings,
    )
    if not existing:
        if not args.create:
            sys.exit(f"mint-code: no pending invite for {email}. Pass --create to write one.")
        psql(
            "insert into invite (email, project_id, status, expires_at) "
            f"values ('{email}', '{args.project}', 'pending', now() + interval '30 days');",
            settings,
        )
        existing = psql(
            f"select id from invite where lower(email) = '{email}' and status = 'pending' limit 1;",
            settings,
        )

    code = generate()
    digest = hashlib.sha256(code.encode()).hexdigest()
    psql(f"update invite set code_hash = '{digest}' where id = '{existing}';", settings)

    grouped = "-".join(code[i : i + 4] for i in range(0, LENGTH, 4))
    print(f"{email}\n  code: {grouped}\n  (stored as sha256, shown once — run again to replace it)")


if __name__ == "__main__":
    main()
