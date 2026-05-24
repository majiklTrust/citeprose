#!/bin/bash

set -a
. .env.pgsql-marketing_ai_instance.local
. .env.linkedin-mdp.local
set +a

# node -e "
# import { withTenant } from './src/db/with-tenant.js';
# import { getLinkedInAccessToken } from './src/tenant/credential-store.js';

# const token = await withTenant(process.env.TENANT_ID, async () => {
#   return getLinkedInAccessToken();
# });
# console.log(token);
# process.exit(0);
# "

node --input-type=module -e "
import { pool } from './src/db/pool.js';
import { withTenant } from './src/db/with-tenant.js';
import { getLinkedInAccessToken } from './src/tenant/credential-store.js';

const token = await withTenant(process.env.TENANT_ID, async () => {
  return getLinkedInAccessToken();
});
console.log(token);
await pool.end();
"

# node --input-type=module -e "
# import { pool } from './src/db/pool.js';
# import { withTenant } from './src/db/with-tenant.js';

# await withTenant(process.env.TENANT_ID, async (client) => {
#   const result = await client.query('SELECT key, updated_at FROM credentials ORDER BY key');
#   if (result.rows.length === 0) {
#     console.log('No credentials found for tenant: ' + process.env.TENANT_ID);
#   } else {
#     console.log('Credentials for tenant ' + process.env.TENANT_ID + ':');
#     result.rows.forEach(r => console.log('  ' + r.key + '  (updated: ' + r.updated_at + ')'));
#   }
# });
# await pool.end();
# "
