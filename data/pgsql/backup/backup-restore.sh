#!/bin/bash
(

# Backup
read -p "origin database ($PGDATABASE) " ORIGIN
echo
if [ -z "$ORIGIN" ];then ORIGIN=$PGDATABASE;fi
pg_dump -U $PGUSER -d $ORIGIN -Fc -f ./backup_${ORIGIN}_$(date +%Y%m%d).dump\
  && echo backup file at: && ls -l ./backup_${ORIGIN}_$(date +%Y%m%d).dump

read -p "destination database (or empty to exit): " DESTINATION
echo
if [ -z "$DESTINATION" ];then echo no destination, exiting && exit 1;fi

# Restore to a new name
createdb -U $PGUSER $DESTINATION
pg_restore -U $PGUSER -d $DESTINATION ./backup_${ORIGIN}_$(date +%Y%m%d).dump
)