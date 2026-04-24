
echo 'executing scripts in order
01-platform.sql          ← tenants, memberships, enums
02-tenant-tables.sql     ← topics, posts, agent_state, etc.
02.1-feeds-normalize.sql ← articles_v2, feeds_v2, feed_topics, feed_articles
03-rls.sql               ← RLS on all tenant-scoped tables
04-roles.sql             ← group roles + grants
05-role_permissions.sql   ← role_permissions table + permissions
06-invites.sql           ← invites table
07-topics-migrate.sql    ← user_sub + description on topics

### using psql -v flag to pass tenant_id
seed-feeds.sql           ← RSS feeds (after tenant + topics exist)
'

destination=linkedin_clean
read -p "database name or press <enter> to use default ($destination):" _destination
if [ -n "$_destination" ];then destination=$_destination;fi
read -p "use $destination for destination (new) database?"
dropdb -U agent $destination 2>/dev/null
createdb -U agent $destination
for sql in \
01-platform.sql          \
02-tenant-tables.sql     \
02.1-feeds-normalize.sql \
03-rls.sql               \
04-roles.sql             \
05-role_permissions.sql  \
06-invites.sql           \
07-topics-migrate.sql    
do
echo -e "\nrunning $sql"
psql -U agent -d $destination -f "data/pgsql/$sql"
done
echo $destination

### USE WHEN POPULATING A NEW TENANT FROM SCRATCH
# psql -U agent -d ***REMOVED*** \
#   -v tenant_id="'53f2e104-4192-439b-abdc-70954bfa9583'" \
#   -f data/pgsql/seed-feeds.sql


origin=linkedin_dev
read -p "origin database name or press <enter> to use default ($origin):" _origin
if [ -n "$_origin" ];then origin=$_origin;fi
read -p "use $origin as origin (source) database?"

### GET ALL DATABASE DATA FROM THE ORIGIN
###### note: -t includes whereas -T excludes
pg_dump -U agent -d $origin --data-only \
  -T feeds \
  -T articles \
  -T role_permissions \
  -T schema_version \
  -f data/pgsql/pg_dump.$origin.sql
### PUT DATABASE DATA INTO NEW DATABASE
if [ -r data/pgsql/pg_dump.$origin.sql ];then ls data/pgsql/pg_dump.$origin.sql
psql -U agent -d $destination -f data/pgsql/pg_dump.$origin.sql
else
echo can''\'t read data/pgsql/pg_dump.$origin.sql
fi

