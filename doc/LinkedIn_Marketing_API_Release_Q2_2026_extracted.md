# LinkedIn Marketing API Release, Q2 2026

## Email Metadata

| Field | Value |
|---|---|
| From | LinkedIn Marketing Developer Team `<no-reply@eml.linkedin.com>` |
| To | brandonryanindia@outlook.com |
| Subject | LinkedIn Marketing API Release Q2 2026 |
| Date | Thu, 02 Jul 2026 08:36:09 -0700 |
| Reply-To | LinkedIn `<bounce@eml.linkedin.com>` |

Note: every link in this email routes through LinkedIn's click-tracking redirector (`t5.eml.linkedin.com/r/?id=...`). The final destination URLs are not visible in the raw HTML and can only be seen by following each redirect, which was not done here.

---

## Body Content

### Intro

Discover latest API releases, priorities and upcoming enhancements.

Hello Brandon R.,

We may have missed connecting with some of you in our last edition in Q1. Please take a moment to review our last quarter's [update here](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf79).

Welcome to our Q2 Partner Product roundup newsletter, where we highlight the latest LinkedIn API updates designed to help partners deliver measureable outcomes for thier customers. *(typos "measureable" and "thier" appear as-is in the source.)*

### Product & Platform Announcements

**Company Intelligence API: 365-Day Lookback and Company Attribute Decoration**
Starting with the 202606 version, the `/accountIntelligence` endpoint adopts the following changes:

- `filterCriteria.lookbackWindow`: a new value `LAST_365_DAYS` is now supported alongside the existing `LAST_7_DAYS`, `LAST_30_DAYS`, `LAST_60_DAYS`, `LAST_90_DAYS`, and `LAST_180_DAYS`. When supplied, engagement and conversion metrics are aggregated over the trailing 365 days from the data calculation date. Versions 202605 and below continue to cap the window at 180 days.
- `companySize`: a `StaffCountRange` enum field (`SIZE_1` through `SIZE_10001_OR_MORE`). Response-only, included in the default projection, defaults to `$UNKNOWN` when not declared.
- `industry`: an `IndustryUrn` field (e.g., `urn:li:industry:1`). Response-only, included in the default projection, defaults to `urn:li:industry:0` when unassigned.
- `countryCode`: ISO country code of the target company's HQ (e.g., "US", "GB"). Response-only, defaults to an empty string when unavailable.
- `costInLocalCurrencyPerPaidQualifiedLead`: a double representing cost per paid qualified lead (CPQL), derived as total ad spend over paid qualified leads within the lookback window. Response-only, defaults to 0.0.

**[Company Intelligence API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7a): Paid Video Views Metric**
Starting with 202605, `/accountIntelligence` adds `paidVideoViews`: a long representing total paid video ad views from members of the target company, aggregated over the configured lookback window. Response-only, defaults to 0.

**New 180-Day Lookback Window**
Starting with 202604, `/accountIntelligence` supports a `LAST_180_DAYS` lookback window, extending the max filter range from 90 to 180 days.

**[Dynamic UTM API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7b): Added dynamic tracking parameter support for CREATIVE_NAME**
Starting with 202606, `/adTrackingParameters` supports `CREATIVE_NAME` in `dynamicTrackingParameters`, letting advertisers track creative names alongside creative ID. Already available in Campaign Manager's URL tracking parameters (Placement tab) as `{{CREATIVE_NAME}}`.

**[Conversation Ads API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7c): "Not Interested" CTA**
Starting July 2026, a "Not Interested" CTA renders automatically on `firstMessageContent` for Sponsored Conversations, applied at render time, not exposed in the API. Use test sends to preview.

**[Message Ads API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7d): "Not Interested" CTA**
Same behavior as above, applied to Message Ads.

**[Events Management API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7e): Off-Platform Event Support and Required End Dates**
Starting with 202605, `/rest/events` adopts the new [Event schema](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7f):

- `hasDarkUgc`: boolean, true means the event is backed only by a dark UGC post from sponsored ad workflows; it has no Events Detail Page and is suppressed from organic surfaces. Create-only, defaults to false.
- `endsAt`: now required on all event types. Omitting it is rejected with a validation error. Breaking change from 202605; 202604 and below still treat it as optional.

**[Event Ads API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf80): Off-Platform Event Ads and Lead Generation Campaign Objective**
Starting with 202605, Event Ads (`/rest/adAccounts/{adAccountId}/adCampaigns` with `format: SPONSORED_UPDATE_EVENT`) gains:

- `objectiveType: LEAD_GENERATION` as a supported objective, alongside `BRAND_AWARENESS`, `WEBSITE_VISITS`, `ENGAGEMENT`. Requires the event to have a lead gen form (`event.leadGenForm`) and be published (`event.ugcPost` populated).
- Off-platform Event Ads: an end-to-end flow for advertisers without an Events Detail Page. Create the backing event with `hasDarkUgc: true`, then proceed through campaign, dark post, and Event Ad creative steps. The ad redirects to the external URL regardless of event lifecycle stage.

**[Conversions API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf81): new identifiers, updated lead validation, cross-account rule fetching**
New optional user identifiers in the `userIds` object in the [Conversion Event User Schema](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf82) for `/rest/conversionEvents` (available on all active versions):

- `PLAINTEXT_IP_ADDRESS`: IP address in plain text; only IPv4 currently supported.
- `GOOGLE_AID`: the Google Advertising ID, a unique, resettable, anonymous Android device identifier.

Updated required-field validation in the [Conversion Event User Schema](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf83): sending conversion events with only `lead` as the user identifier is now allowed (previously a 400 error). Available on all active versions.

[Find Conversion Rules by Ad Account API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf84) now supports an optional array parameter `conversionOwnershipTypes` (`OWNED`, `SHARED`), with a new response field `ownershipType`. Lets callers fetch both owned and cross-account shared conversions in the same Business Manager. Omitting the parameter defaults to `OWNED` only, preserving prior behavior for 202604 and earlier.

**[Predictive Audiences API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf85): new method to get all predictive audiences in the account**
Starting with 202604, supports `GET_ALL` on `/rest/dmpSegments/{dmpSegmentId}/businessObjectiveBasedAudiences`, returning all predictive audiences under a parent DMP segment as a paginated collection.

**[Ad Analytics API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf86): new metric for Appointments Scheduled from Lead Gen Forms**
Starting with 202605, the [AdAnalytics API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf87) adds `appointmentsScheduled` to `/rest/adAnalytics`, measuring appointments booked through Lead Gen campaigns.

**[Member Post Statistics](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf88): new creator analytics metrics**
Starting with 202604, `/memberCreatorPostAnalytics` adds:

- `POST_SEND`: times post entities were sent via LinkedIn messaging
- `POST_SAVE`: times post entities were saved
- `LINK_CLICKS`: clicks on links within post entities
- `PREMIUM_CTA_CLICKS`: clicks on premium call-to-action buttons
- `FOLLOWER_GAINED_FROM_CONTENT`: new followers gained from post entities
- `PROFILE_VIEW_FROM_CONTENT`: profile views generated from post entities

### New Integration Requirements Pages

New pages guide developers on technical criteria for integrating with LinkedIn Marketing Solutions APIs; these must be met as part of partner certification:

- [Community Management](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf89)
- [Event Management](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8a)
- [Conversions API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8b)
- [Reporting API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8c)
- [Advertising API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8d)
- [Audience Insights](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8e)
- [Media Planning](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8f)
- [Company Intelligence](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf90)
- [Matched Audiences](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf91)
- [Lead Sync](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf92)

### Reminders

**Change to Developer Support path**
Starting today, contact Developer Support via the [Developer Support Request Form](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf93), the primary path going forward. The Zendesk support path sunsets on June 30th; use the form for all new requests.

**Reapply to API Products from your developer portal**
Developers can now resubmit expired API access requests (21-day expiry) or requests declined for insufficient detail directly in the Developer Portal. A "Reapply" CTA replaces "Access denied," reloads the original form for edits, and creates a new case, with no need to recreate the app or contact support.

**[Member Post Statistics API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf94): new creator analytics metrics** *(this repeats the same metric list and description as the Product & Platform Announcements section above, using a different tracking link.)*

### Breaking Changes

**[Member Posts Statistics API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf95) and [Member Video Statistics API](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf96)**
Starting with 202605, `/memberCreatorPostsAnalytics` and `/memberCreatorVideoAnalytics` change `metricType` in the response body from object to string, to simplify parsing.

The monthly API versions below are being sunset per the [migrations](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf97) documentation. [Migrate](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf98) to the latest version to avoid disruption:

- 202504, sunset Apr 15, 2026
- 202505, sunset May 15, 2026
- 202506, sunset Jun 15, 2026

### Version Sunset

Second sunset list (same wording, different date set):

- 202505, sunset May 15, 2026
- 202506, sunset Jun 15, 2026
- 202507, sunset Jul 15, 2026

### Closing

Make sure you're getting critical updates about the LinkedIn Developer Platform and products, including API changes, migrations or deprecations, and new product releases, by adding your preferred business email to your [LinkedIn app settings](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf99). Add a colleague as a team member under *My Apps* in the developer platform if they aren't receiving this communication.

To stay informed of the latest API news, subscribe to the [Recent Changes page](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9a) in documentation. Submit a [Zendesk](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9b) ticket for questions.

Sincerely,
LinkedIn Marketing Developer Team

### Footer

This email was intended for brandonryanindia@outlook.com. [Learn why we included this.](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9c) | [Help](https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9d)

© 2026, LinkedIn Ireland Unlimited Company. All rights reserved.
LinkedIn Ireland Unlimited Company, Gardner House, Wilton Plaza, Wilton Place, Dublin 2, Ireland.
LinkedIn and the LinkedIn logo are registered trademarks of LinkedIn.

---

## Complete Link Reference Table

All 39 links found in the source HTML, in document order. Anchor text is blank where the link wraps only an image (logo, tracking pixel).

| # | Anchor Text | Tracking URL |
|---|---|---|
| 1 | (header logo image) | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf76 |
| 2 | (name/profile image) | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf78 |
| 3 | update here | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf79 |
| 4 | Company Intelligence API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7a |
| 5 | Dynamic UTM API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7b |
| 6 | Conversation Ads API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7c |
| 7 | Message Ads API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7d |
| 8 | Events Management API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7e |
| 9 | Event schema | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf7f |
| 10 | Event Ads API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf80 |
| 11 | Conversions API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf81 |
| 12 | Conversion Event User Schema | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf82 |
| 13 | Conversion Event User Schema | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf83 |
| 14 | Find Conversion Rules by Ad Account API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf84 |
| 15 | Predictive Audiences API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf85 |
| 16 | Ad Analytics API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf86 |
| 17 | AdAnalytics API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf87 |
| 18 | Member Post Statistics: | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf88 |
| 19 | Community Management | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf89 |
| 20 | Event Management | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8a |
| 21 | Conversions API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8b |
| 22 | Reporting API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8c |
| 23 | Advertising API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8d |
| 24 | Audience Insights | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8e |
| 25 | Media Planning | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf8f |
| 26 | Company Intelligence | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf90 |
| 27 | Matched Audiences | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf91 |
| 28 | Lead Sync | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf92 |
| 29 | Developer Support Request Form | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf93 |
| 30 | Member Post Statistics API: | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf94 |
| 31 | Member Posts Statistics API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf95 |
| 32 | Member Video Statistics API | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf96 |
| 33 | migrations | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf97 |
| 34 | migrate | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf98 |
| 35 | LinkedIn app settings | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf99 |
| 36 | Recent Changes page | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9a |
| 37 | Zendesk | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9b |
| 38 | Learn why we included this. | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9c |
| 39 | Help | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9d |
| 40 | (footer logo image) | https://t5.eml.linkedin.com/r/?id=haa6589,14033,cf9e |

Also present but not a clickable `<a>` link: a 0x0 tracking pixel `<img>` at `https://t5.eml.linkedin.com/r/?id=haa6589,14033,1` (open-tracking beacon), and a static image asset `https://res1.em.linkedin.com/res/tracking/linkedin-blue-80x20.png` (the LinkedIn logo graphic itself).
