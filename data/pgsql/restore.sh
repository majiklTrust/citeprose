#!/bin/bash
(
function get_sequence_names {
psql -P pager=off -t -c "
SELECT table_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND identity_generation IS NOT NULL
   OR column_default LIKE 'nextval%'
ORDER BY table_name;
"
}

function get_sequence_tables {
psql -P pager=off -c "
SELECT table_name, column_name,
       pg_get_serial_sequence(table_name, column_name) AS sequence_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND identity_generation IS NOT NULL
   OR column_default LIKE 'nextval%'
ORDER BY table_name;
"
}
function fix_seq {
# If seq_val >= max_id, you're good.
table_list=($(get_sequence_names))
for t in ${table_list[@]};do
SQL="SELECT '$t' tbl, setval(
  pg_get_serial_sequence('$t', 'id'),
  COALESCE((SELECT MAX(id) FROM $t), 0) + 1,
  false
)"
psql -P pager=off -c "$SQL"
done
# for t in activity_log articles_v2 feed_articles feed_topics feeds_v2 posts topics ;do
# SQL="SELECT '$t' tbl, setval(
#   pg_get_serial_sequence('$t', 'id'),
#   COALESCE((SELECT MAX(id) FROM $t), 0) + 1,
#   false
# )"
# psql -P pager=off -c "$SQL"
# done
}

# Backup
read -p "set origin database ($PGDATABASE): " ORIGIN
echo
if [ -z "$ORIGIN" ];then ORIGIN=$PGDATABASE;fi
pg_dump -U $PGUSER -d $ORIGIN -Fc -f ./backup/local_${ORIGIN}_$(date +%Y%m%d_T_%H%M).dump\
  && echo backup file at: && ls -l ./backup/local_${ORIGIN}_$(date +%Y%m%d_T_%H%M).dump

ls /datavol/pgbackup/ && echo
read -p "which .dump to restore from /datavol/pgbackup/ (or empty to exit): " RESTORE
echo
if [ -z "$RESTORE" ];then echo no restore, exiting && exit 1;fi
RESTORE=/datavol/pgbackup/$RESTORE
if [ -r "$RESTORE" ];then :;else echo cannot read $RESTORE, exiting && exit 1;fi

read -p "destination database ($ORIGIN): " DESTINATION
echo
if [ -z "$DESTINATION" ];then DESTINATION=$ORIGIN;fi

# Restore to a new name
if psql -Atc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'" postgres >/dev/null; then
dropdb -i --force $DESTINATION
fi
createdb -U $PGUSER $DESTINATION
pg_restore -U $PGUSER -d $DESTINATION $RESTORE
# get_sequence_tables
fix_seq
)
