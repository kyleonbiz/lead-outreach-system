#!/usr/bin/env bash
# Applies supabase/migrations to a throwaway Postgres cluster and runs supabase/tests/*.test.sql.
# Usage: scripts/test-db.sh        (needs postgresql-16 server binaries)
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
WORK=$(mktemp -d)
PORT=${PGPORT_TEST:-54329}
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# initdb refuses to run as root, so use a service user when needed
RUN=""
if [ "$(id -u)" = "0" ]; then
  id -u pgtest >/dev/null 2>&1 || useradd -m pgtest
  chown pgtest "$WORK"; chmod 755 "$WORK"
  cp -r supabase "$WORK/supabase"; chown -R pgtest "$WORK/supabase"
  SRC="$WORK/supabase"
  RUN="runuser -u pgtest --"
else
  SRC="supabase"
fi

$RUN "$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
PSQL="psql -h $WORK -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

$PSQL -d postgres -c "create database t" >/dev/null
$PSQL -d t -f "$SRC/tests/00_supabase_stub.sql" >/dev/null
for f in "$SRC"/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  $PSQL -d t -f "$f" >/dev/null
done

fail=0
for f in "$SRC"/tests/*.test.sql; do
  echo "test: $(basename "$f")"
  $PSQL -d t -f "$f" 2>&1 || fail=1
done
[ "$fail" = 0 ] && echo "ALL DB TESTS PASSED" || { echo "DB TESTS FAILED"; exit 1; }
