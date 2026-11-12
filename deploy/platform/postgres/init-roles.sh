#!/bin/sh
# Runs once, when the data directory is first initialised.
# Creates one role and database per consumer. Passwords come from the
# environment (Secrets generated in the cluster) and are passed to psql as
# variables, never interpolated into the shell.
set -eu

create() { # create <role> <database> <password-env-name>
  eval "pw=\${$3}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
       -v role="$1" -v db="$2" -v pw="$pw" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'pw';
CREATE DATABASE :"db" OWNER :"role";
SQL
}

create forgejo forgejo FORGEJO_DB_PASSWORD
create idea idea IDEA_DB_PASSWORD
