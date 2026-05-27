#!/bin/bash
(

    function fix_seq {
      for t in activity_log articles_v2 feed_articles feed_topics feeds_v2 posts topics ;do
      psql -P pager=off -t -c "
      SELECT t.table_name,
       t.seq_name,
       (SELECT last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = t.seq_name) AS seq_val,
       t.max_id
        FROM (
        SELECT '$t' AS table_name, '${t}_id_seq' AS seq_name, (SELECT MAX(id) FROM $t) AS max_id
        ) t;"
      done
    }
# Backup
read -p "backup origin database ($PGDATABASE): " ORIGIN
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

read -p "destination database (or empty to exit): " DESTINATION
echo
if [ -z "$DESTINATION" ];then echo no destination, exiting && exit 1;fi

# Restore to a new name
if psql -Atc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'" postgres >/dev/null; then
dropdb -i --force $DESTINATION
fi
createdb -U $PGUSER $DESTINATION
pg_restore -U $PGUSER -d $DESTINATION $RESTORE
fix_seq
)
