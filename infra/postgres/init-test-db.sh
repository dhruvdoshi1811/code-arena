#!/bin/sh
# Runs once, on first initialisation of the postgres data volume.
# The test suite needs a database it can truncate freely without touching dev data.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE codearena_test OWNER $POSTGRES_USER;
EOSQL
