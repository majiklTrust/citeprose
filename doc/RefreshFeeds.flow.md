## Table of Contents
- [Research Monitor, Refresh Feeds Now button](#research-monitor-refresh-feeds-now-button)

## Research Monitor, Refresh Feeds Now button
[back to top ↩](#table-of-contents)

```
public_templates/index.html::handleRefreshFeeds()
  → fetch('POST /api/research/poll')

src/routes/api.js::POST /api/research/poll
  → withTenant(req.tenant.id: string, callback: async Function)
    → news-monitor.js::pollAllFeeds(): Promise<{ newArticles: number, linked: number }>

src/services/news-monitor.js::pollAllFeeds()
  → client().query('SELECT * FROM feeds_v2 WHERE enabled = true ORDER BY last_polled_at ASC NULLS FIRST')
  → for each feedRow: { id: number, url: string, name: string, tier: string, refresh_minutes: number, last_polled_at: Date|null }
    → checks: skip if last_polled_at + refresh_minutes > now()
    → news-monitor.js::fetchFeed(feedRow: object): Promise<{ newArticles: number, linked: number }>
    → 1500ms delay between feeds

src/services/news-monitor.js::fetchFeed(feedRow: object)
  → rss-parser::parseURL(feedRow.url: string): Promise<Feed>
  → captures channel metadata: feed.description, feed.categories
  → for each item in feed.items:
    → sanitize-content.js::sanitizeLink(item.link: string): string
    → sanitize-content.js::sanitizeTitle(item.title: string): string
    → sanitize-content.js::sanitizeSummary(rawSummary: string): string
    → sanitize-content.js::detectPromptInjection(cleanSummary: string): boolean
    → INSERT INTO articles_v2 (url, title, summary, published_at) ON CONFLICT DO NOTHING
    → INSERT INTO feed_articles (tenant_id, feed_id, article_id) ON CONFLICT DO NOTHING
  → UPDATE feeds_v2 SET last_polled_at, last_error, feed_description, feed_categories
  → DELETE FROM feed_articles WHERE published_at < MAX_AGE_DAYS_PRUNE
  → database.js::logActivity('info', 'feed_poll_complete', { newArticles, linked, prunedLinks })
```

The return value bubbles back up:

```
fetchFeed → { newArticles: number, linked: number }
pollAllFeeds → aggregated { newArticles: total, linked: total }
api.js → res.json({ success: true, newArticles, linked })
handleRefreshFeeds → calls fetchAll() to refresh the dashboard
```

What logging visibility are you looking for — more detail in the Activity Log about which feeds were polled and their results, or console-level debugging?