createdb -U agent linkedin_dev -T ***REMOVED***

-- # Stop the app first for a clean snapshot, or accept a running snapshot
createdb -U agent linkedin_dev

-- # Dump and restore in one pipeline (no intermediate file)
pg_dump -U agent ***REMOVED*** | psql -U agent linkedin_dev

-- # Or with a file for repeatability
pg_dump -U agent -Fc ***REMOVED*** -f ./data/pgsql/backup/***REMOVED***_snapshot.dump.$(date +%Y%m%d)
pg_restore -U agent -d linkedin_dev ./data/pgsql/backup/***REMOVED***_snapshot.dump.$(date +%Y%m%d)
