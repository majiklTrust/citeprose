#!/bin/bash
# bash ../build/apikey-set-for-tenant.sh
(
. .env
node --input-type=module -e "
import dotenv from 'dotenv';
dotenv.config();
import { withTenant } from './src/db/with-tenant.js';
import { storeCredential } from './src/tenant/credential-store.js';
await withTenant('$TENANT_ID', async () => {
  await storeCredential('anthropic_api_key', '$APIKEY');
});
console.log('Done');
"
)