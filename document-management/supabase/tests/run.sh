#!/usr/bin/env bash
# Applies every migration to a throwaway local PostgreSQL 16 (with stubbed
# Supabase auth/storage schemas) and runs the RLS test suite.
# Usage: supabase/tests/run.sh   (PG_BIN defaults to /usr/lib/postgresql/16/bin)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d)"
PORT="${PGTEST_PORT:-54329}"
if [ "$(id -u)" = 0 ]; then
  chown postgres "$WORK"; chmod a+rx "$HERE" "$HERE/../migrations" "$HERE/../.." 2>/dev/null || true
  RUN() { su postgres -s /bin/bash -c "$*"; }
else
  RUN() { bash -c "$*"; }
fi
cleanup() { RUN "'$PG_BIN/pg_ctl' -D '$WORK/data' -m immediate stop >/dev/null 2>&1" || true; rm -rf "$WORK"; }
trap cleanup EXIT
RUN "'$PG_BIN/initdb' -D '$WORK/data' -A trust -U postgres >/dev/null"
RUN "'$PG_BIN/pg_ctl' -D '$WORK/data' -o \"-p $PORT -k $WORK -c listen_addresses=''\" -l '$WORK/log' -w start >/dev/null"
PSQL="'$PG_BIN/psql' -h '$WORK' -p $PORT -U postgres -v ON_ERROR_STOP=1 -X -q"
RUN "$PSQL -d postgres -c 'create database dms'"
RUN "$PSQL -d dms -f '$HERE/stubs.sql'"
for f in "$HERE"/../migrations/*.sql; do
  echo "applying $(basename "$f")"
  RUN "$PSQL -d dms -f '$f'"
done
RUN "$PSQL -d dms -f '$HERE/rls.sql'" 2>&1 | grep -E "PASS|FAIL|ALL RLS|ERROR" | sed 's/^psql:[^ ]* //'
