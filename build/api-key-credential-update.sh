#!/bin/sh
(
basedir=${1:-../linkedin-agent/linkedin-agent}
if [ ! -d $basedir ];then echo no base dir $basedir - pass basedir as \$1 && exit 1;fi
cd $basedir || exit 1
if [ ! -r ./src/tenant/credential-store.js ] || [ ! -r ./src/db/with-tenant.js ]; then
echo "can't read credential or tenant files" && exit 1
fi
### USE CASE ###
# UPDATE MODEL BACKEND
### USE CASE ###

set -a
source .env.pgsql-marketing_ai_instance.local
set +a

#### USE CASE ###
# SET API KEY (ENCRYPTED)
# LOCAL NODE.JS SERVER IS RUNNING
# PSQL VARIABLES ARE SET
#### USE CASE ###

read -s -p "tenant id:" TENANT_ID
echo
read -s -p "api key:" APIKEY
echo
# read -p "model:" MODEL
# echo
response=$(curl -s -o /dev/null -w "%{http_code}"   https://api.anthropic.com/v1/models   -H "x-api-key: $APIKEY"   -H "anthropic-version: 2023-06-01")
if [[ "$responsne" = 401 ]];then echo invalid or revoked key && exit 1;
elif [[ "$responsne" = 403 ]];then echo insufficient permissions && exit 1;fi
(
node -e "
import 'dotenv/config';
import { withTenant } from './src/db/with-tenant.js';
import { storeCredential } from './src/tenant/credential-store.js';

const tenantId = process.argv[1];
const apiKey = process.argv[2];

await withTenant(tenantId, async () => {
  await storeCredential('anthropic_api_key', apiKey);
});

console.log('Credential stored for tenant', tenantId);
process.exit(0);
" "$TENANT_ID" "$APIKEY"

)


)
