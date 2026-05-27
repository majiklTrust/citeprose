#!/bin/bash
(
PGBACKUP=alpha_${PGDATABASE}_$(date +%Y%m%d_T_%H%M).dump\
  && pg_dump -U $PGUSER -d $PGDATABASE -Fc -f $(pwd)/$PGBACKUP\
  && chmod 400 $(pwd)/$PGBACKUP\
  && echo $PGBACKUP
)