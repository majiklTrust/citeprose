#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// LinkedIn OAuth Setup Helper
// Run: npm run auth
// ═══════════════════════════════════════════════════════════════

import "dotenv/config";
import open from "open";

const PORT = process.env.DASHBOARD_PORT || 3001;
const authUrl = `http://localhost:${PORT}/auth/linkedin`;

console.log(`
╔═══════════════════════════════════════════════════════════╗
║              LinkedIn OAuth 2.0 Setup                     ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  Prerequisites:                                           ║
║  1. Create a LinkedIn App at:                             ║
║     https://www.linkedin.com/developers/apps              ║
║                                                           ║
║  2. Add these products to your app:                       ║
║     • "Share on LinkedIn"                                 ║
║     • "Sign In with LinkedIn using OpenID Connect"        ║
║                                                           ║
║  3. Set your redirect URI to:                             ║
║     ${process.env.LINKEDIN_REDIRECT_URI || `http://localhost:${PORT}/auth/linkedin/callback`}
║                                                           ║
║  4. Copy Client ID and Secret to your .env file           ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  Make sure the agent server is running first:             ║
║    npm run dev                                            ║
║                                                           ║
║  Then this script will open the auth flow in your         ║
║  browser. After authorizing, you'll get the access        ║
║  token to add to your .env file.                          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

console.log(`Opening: ${authUrl}\n`);

try {
  await open(authUrl);
  console.log("Browser opened. Complete the authorization flow there.");
} catch {
  console.log(`Could not open browser. Visit this URL manually:\n${authUrl}`);
}
