#!/bin/sh
(
set -a
source .env
set +a

read -s -p "tenant id:" TENANT_ID
echo
read -s -p "api key:" API_KEY
echo
read -s -p "model:" MODEL
echo

node --input-type=module -e "
import { withTenant } from './src/db/with-tenant.js';
import { storeCredential } from './src/tenant/credential-store.js';

await withTenant('$TENANT_ID', async () => {
  await storeCredential('anthropic_api_key', '$API_KEY');
  await storeCredential('anthropic_model', '$MODEL');
  console.log('Credentials stored.');
});

process.exit(0);
"
)
