#!/bin/bash
# bash ../build/apikey-check-for-tenant.sh
(
. .env

node --input-type=module -e "
import dotenv from 'dotenv';
dotenv.config();
import { withTenant } from './src/db/with-tenant.js';
import { getAnthropicApiKey } from './src/tenant/credential-store.js';
try {
  const key = await withTenant('$TENANT_ID', async () => {
    return await getAnthropicApiKey();
  });
  console.log('Decrypted OK, key starts with:', key.substring(0, 14));
} catch (err) {
  console.error('Decrypt FAILED:', err.message);
}
process.exit(0);
"

)
