#!/bin/bash
(
read -s -p "tenant id: " TENANT_ID
read -s -p "api key " API_KEY
read -s -p "model: " MODEL
node -e "
import { withTenant } from './src/db/with-tenant.js';
import { storeCredential } from './src/tenant/credential-store.js';

const TENANT_ID = '$TENANT_ID';
const API_KEY = '$API_KEY';
const API_KEY = '$MODEL';

await withTenant(TENANT_ID, async () => {
  await storeCredential('anthropic_api_key', API_KEY);
  await storeCredential('anthropic_model', MODEL);
  console.log('Credentials stored.');
});

process.exit(0);
"
)