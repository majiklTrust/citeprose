# Opus 4.6 AI partnershship processes for SDLC lifecycle

**Created:** 4/7/2026 17:34:07  
**Updated:** 5/20/2026 17:26:38  
**Exported:** 5/20/2026 17:28:36  
**Link:** [https://claude.ai/chat/01884c86-5d68-443c-a45a-9960e176f34f](https://claude.ai/chat/01884c86-5d68-443c-a45a-9960e176f34f)  

## Response:
5/20/2026, 5:26:38 PM

**CloudFront → ALB → Node → Anthropic**

| Layer | Setting | Value | How to check | What it controls |
|---|---|---|---|---|
| CloudFront | `OriginReadTimeout` | 120s | aws cloudfront get-distribution-config --id $STATIC_FRONTEND_DISTRIBUTION_ID --query \'DistributionConfig.Origins.Items[?CustomOriginConfig!=null].{Id:Id,ReadTimeout:CustomOriginConfig.OriginReadTimeout,KeepAlive:CustomOriginConfig.OriginKeepaliveTimeout}' --output text | How long CloudFront will wait for your server to start sending a response before giving up and showing an error page to the user. |
| ALB | `idle_timeout` | 1200s | aws elbv2 describe-load-balancer-attributes   --load-balancer-arn $(aws elbv2 describe-load-balancers --query 'LoadBalancers[0].LoadBalancerArn' --output text)   --query 'Attributes[?Key==`idle_timeout.timeout_seconds`].Value' --output text | How long the load balancer keeps a connection open while waiting for data to flow. If nothing is sent for this many seconds, the connection is dropped. |
| Node HTTP | `server.requestTimeout` | 300s (default) | `node -e "import('http').then(h => { const s = h.createServer(); console.log(s.requestTimeout + 'ms'); s.close(); })"` | Maximum time Node.js allows for an entire request-response cycle before forcibly closing it. Not set in code — uses the Node 22 default. |
| Node HTTP | `server.timeout` | 0 (disabled) | `node -e "import('http').then(h => { const s = h.createServer(); console.log(s.timeout + 'ms (0=disabled)'); s.close(); })"` | An inactivity timer on each connection. Disabled by default — Node will wait indefinitely for data. Not set in code. |
| Node HTTP | `server.keepAliveTimeout` | 5s (default) | `node -e "import('http').then(h => { const s = h.createServer(); console.log(s.keepAliveTimeout + 'ms'); s.close(); })"` | After a response is sent, how long the server holds the connection open in case the browser wants to send another request on the same connection. |
| PG pool | `connectionTimeoutMillis` | 5s | `grep connectionTimeoutMillis ~/linkedin-agent/linkedin-agent/src/db/pool.js` | How long the application waits to get a database connection from the pool before giving up. |
| PG pool | `idleTimeoutMillis` | 30s | `grep idleTimeoutMillis ~/linkedin-agent/linkedin-agent/src/db/pool.js` | How long an unused database connection sits idle before the pool closes it to free resources. |

**Application-level delays inside the request**

| Delay | Duration | How to check | What it controls |
|---|---|---|---|
| Research cooldown | 65s | `grep "COOLDOWN_MS" ~/linkedin-agent/linkedin-agent/src/services/research.js` | A mandatory pause between AI calls during the research phase, inserted to avoid hitting Anthropic's rate limits. Only applies when the corroboration feature is turned on. |
| Generation cooldown | 65s (hardcoded) | `grep "65000" ~/linkedin-agent/linkedin-agent/src/services/content-generator.js` | A mandatory pause before the AI writes the post, again to avoid rate limits. This pause always runs — there is no toggle to skip it. |
| Anthropic API call | ~13–15s each | `pm2 logs linkedin-agent --nostream --lines 50 2>&1 \| grep content_generation_success \| tail -1` (look at `durationMs`) | The time the AI takes to think and write. Not configurable — depends on prompt length, model speed, and Anthropic's server load. |
| RSS fetch timeout | 15s | `grep "timeout:" ~/linkedin-agent/linkedin-agent/src/services/news-monitor.js \| head -1` | Maximum time allowed to download a single news feed. If the feed's server doesn't respond in 15 seconds, the fetch is abandoned. |

**Pipeline total time by mode**

| Path | Breakdown | Total | How to check which mode is active |
|---|---|---|---|
| Corroboration **ON** | research AI call (15s) + wait (65s) + corroboration AI call (15s) + wait (65s) + writing AI call (15s) + quality review AI call (10s) | **~185s** | `sudo -u ubuntu podman exec marketing_ai_instance psql -U agent_super -d linkedin_posting_database -c "SELECT tenant_id, value FROM agent_state WHERE key = 'corroboration'"` — result of `disabled` means OFF, `enabled` or missing means ON |
| Corroboration **OFF** | research AI call (15s) + wait (65s) + writing AI call (15s) + quality review AI call (10s) | **~105s** | Same command above |

**The gap:** CloudFront gives up at 120s. With corroboration off, the pipeline takes ~105s (fits, but tight). With corroboration on, ~185s (always fails). Even raising CloudFront to its maximum of 180s only covers the corroboration-off path with comfortable margin — the corroboration-on path still exceeds it.





---
Powered by [Claude Exporter](https://www.ai-chat-exporter.net)