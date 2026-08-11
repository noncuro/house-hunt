"""Set a password on an existing account, without sending anybody an email.

WHY THIS EXISTS. Sign-in stopped depending on email on purpose, and the dashboard's "Reset password"
button did not get the message — it sends a recovery link, which is the dependency we removed, and
the link redirects to the project's Site URL, which is `localhost:3000` and is not running. So there
is no working button for "this person cannot sign in, give them a password".

Two cases need it:

  - An account that predates the change. It has an `encrypted_password` GoTrue generated during the
    emailed-code era, so it is not null and it is not anything anybody knows.
  - Somebody who forgot theirs. There is deliberately no self-service reset, so this is the repair.

The password is read from a prompt rather than an argument, so it does not reach the shell history,
the process list, or a terminal transcript. It is written with bcrypt through pgcrypto, which is the
same scheme and cost GoTrue uses, so the row is indistinguishable from one GoTrue wrote itself.

    python3 tools/set-password.py user@example.com
"""

import argparse
import getpass
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Matches MIN_PASSWORD_LENGTH in src/lib/auth.ts and in the password edge function. Checked here too
# because this path goes straight to the database and meets neither of them.
MIN_LENGTH = 10


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    missing = [k for k in ("SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD") if k not in values]
    if missing:
        sys.exit(f"set-password: .env is missing {', '.join(missing)}")
    return values


def psql(sql: str, settings: dict[str, str], stdin: str | None = None) -> str:
    """Statements come in on stdin, never as an argument.

    psql has no bind parameters for `-c`, and putting the password on the command line would put it
    in the process list where any other user on the machine can read it. Feeding the statement
    through stdin keeps it out of argv, out of the shell's history, and off the disk.
    """
    result = subprocess.run(
        [
            "psql",
            "-h", "aws-1-eu-west-1.pooler.supabase.com",
            "-p", "5432",
            "-U", f"postgres.{settings['SUPABASE_PROJECT_REF']}",
            "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            "-tA",
            *(["-f", "-"] if stdin is not None else ["-c", sql]),
        ],
        input=stdin,
        capture_output=True,
        text=True,
        env={**os.environ, "PGPASSWORD": settings["SUPABASE_DB_PASSWORD"]},
    )
    if result.returncode != 0:
        sys.exit(f"set-password: psql failed\n{result.stderr.strip()}")
    return result.stdout.strip()


def sql_literal(value: str) -> str:
    """A single-quoted SQL string. Doubling the quotes is the whole escape; the E'' form is avoided
    so a backslash in a password stays a backslash."""
    return "'" + value.replace("'", "''") + "'"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("email")
    args = parser.parse_args()
    email = args.email.strip().lower()
    settings = env()

    found = psql(
        f"select count(*) from auth.users where lower(email) = '{email}';", settings
    )
    if found != "1":
        sys.exit(f"set-password: no account for {email} (found {found})")

    password = getpass.getpass(f"New password for {email}: ")
    if len(password) < MIN_LENGTH:
        sys.exit(f"set-password: at least {MIN_LENGTH} characters, please")
    if password != getpass.getpass("Again: "):
        sys.exit("set-password: they did not match")

    psql(
        "",
        settings,
        stdin=(
            "update auth.users "
            f"   set encrypted_password = extensions.crypt({sql_literal(password)}, "
            "                                             extensions.gen_salt('bf')), "
            "       updated_at = now(), "
            # An account from the emailed-code era can be unconfirmed, and an unconfirmed account
            # cannot sign in with a password. Nothing sends mail to confirm it, so confirm it here.
            "       email_confirmed_at = coalesce(email_confirmed_at, now()) "
            f" where lower(email) = {sql_literal(email)};"
        ),
    )
    print(f"set. Sign in as {email} with the password you just typed.")


if __name__ == "__main__":
    main()
