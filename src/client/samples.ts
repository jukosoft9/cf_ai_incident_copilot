// Invented incidents, so the app can be tried without a real outage to hand.
export const SAMPLES = [
  {
    label: "Postgres: too many clients",
    text: `Checkout API is returning 500s since about 14:05 UTC. We deployed a new version of the orders service at 13:58.

App log:
FATAL: remaining connection slots are reserved for non-replication superuser connections
FATAL: sorry, too many clients already

PostgreSQL 15.6, max_connections = 200, no pgbouncer.

SELECT state, count(*), max(now() - state_change) AS longest
FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY state;

        state        | count |     longest
---------------------+-------+-----------------
 active              |    11 | 00:00:02.4
 idle                |    16 | 00:12:41
 idle in transaction |   170 | 00:09:37

SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC LIMIT 3;
 orders-service | 176
 billing-worker |  14
 psql           |   1`,
  },
  {
    label: "MySQL: replication lag",
    text: `Read replica lag alert has been firing for 90 minutes and is still growing. Reports read from this replica and are showing stale data. The primary looks healthy.

MySQL 8.0.36, binlog_format = ROW, replica_parallel_workers = 4.

SHOW REPLICA STATUS\\G (excerpt)
  Replica_IO_Running: Yes
  Replica_SQL_Running: Yes
  Seconds_Behind_Source: 5412
  Source_Log_File: binlog.004127
  Relay_Source_Log_File: binlog.004119
  Last_SQL_Error:

SHOW PROCESSLIST (excerpt)
  system user | Waiting for an event from Coordinator
  system user | Applying batch of row changes (delete) | Time: 5398

A retention job ran on the primary at 09:00:
DELETE FROM audit_events WHERE created_at < '2026-01-01';
It affected about 4.2 million rows.

SHOW CREATE TABLE audit_events: the table has no primary key and no unique key, and has one secondary index on (tenant_id).`,
  },
  {
    label: "Postgres: migration lock queue",
    text: `The user-profile API started timing out at 02:10 UTC during our migration window. Other tables seem fine. CPU and IO on the database are normal.

PostgreSQL 16.2.

SELECT pid, state, wait_event_type, now() - xact_start AS xact_age, pg_blocking_pids(pid) AS blocked_by, left(query, 60) AS query
FROM pg_stat_activity WHERE datname = 'app' AND (wait_event_type = 'Lock' OR xact_start < now() - interval '5 minutes');

  pid  | state  | wait_event_type | xact_age | blocked_by | query
-------+--------+-----------------+----------+------------+---------------------------------------------
 41022 | active | IO              | 03:12:44 | {}         | SELECT u.region, count(*) FROM users u JOIN ...
 51877 | active | Lock            | 00:06:03 | {41022}    | ALTER TABLE users ADD COLUMN locale text
 51902 | active | Lock            | 00:05:58 | {51877}    | SELECT * FROM users WHERE id = $1
 51903 | active | Lock            | 00:05:57 | {51877}    | UPDATE users SET last_seen = now() WHERE id
 (another 212 rows like the last two)

lock_timeout is not set for the migration role. Pid 41022 is an analyst's report.`,
  },
];
