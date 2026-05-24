#!/bin/bash
(

# Backup
read -p "origin database ($PGDATABASE) " ORIGIN
echo
if [ -z "$ORIGIN" ];then ORIGIN=$PGDATABASE;fi
pg_dump -U $PGUSER -d $ORIGIN -Fc -f ./backup/local_${ORIGIN}_$(date +%Y%m%d_T_%H%M).dump\
  && echo backup file at: && ls -l ./backup/local_${ORIGIN}_$(date +%Y%m%d_T_%H%M).dump

read -p "destination database (or empty to exit): " DESTINATION
echo
if [ -z "$DESTINATION" ];then echo no destination, exiting && exit 1;fi

# Restore to a new name
if [ ! -r ./restore/${ORIGIN}_$(date +%Y%m%d).dump no found ];then echo ./restore/${ORIGIN}_$(date +%Y%m%d).dump no found && exit 1;fi
createdb -U $PGUSER $DESTINATION
pg_restore -U $PGUSER -d $DESTINATION ./restore/${ORIGIN}_$(date +%Y%m%d).dump
)
