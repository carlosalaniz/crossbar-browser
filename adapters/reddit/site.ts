// SPDX-License-Identifier: AGPL-3.0-only
// Reddit adapter. Signed in, it prefers old.reddit.com, which paginates and renders server-side (ADRs 0004, 0012).
import type { SiteAdapter } from "../src/index.ts";

export const reddit: SiteAdapter = {
  id: "reddit",
  domains: ["reddit.com", "redd.it", "redditstatic.com", "redditmedia.com", "reddituploads.com"],
  readOperations: {
    // New Reddit sends reads as GraphQL POSTs; these only fetch.
    graphql: ["CommentsPageQuery", "PostInfoById", "SubredditInfoByName", "FeedQuery", "HomeFeedSdui", "PopularFeedSdui", "SearchPosts", "SearchSubreddits", "UserProfileQuery", "MoreComments", "ExperimentVariants", "GetRedditPremiumUsers"],
    // GraphQL reads are matched by operationName only; never allow the whole /graphql endpoint.
    endpoints: [
      { method: "POST", path: /^\/svc\/shreddit\/more-comments\// },
      { method: "POST", path: /^\/svc\/shreddit\/events$/ },
      { method: "POST", path: /^\/api\/morechildren(\.json)?$/ },
      { method: "POST", path: /^\/api\/expando\b/ },
    ],
  },
  // Seen live (11 Nov 2026): analytics and performance beacons, sent while merely reading.
  telemetry: [/^pi\.reddit\.com\//, /^w3-reporting\.reddit\.com\//, /\/svc\/shreddit\/perfMetrics$/, /^(www|old)\.reddit\.com\/reports$/],
  consent: { rejectSelector: "button[data-testid='reject-nonessential-cookies'], shreddit-async-loader button:has-text('Reject')" },
  sensitivePaths: [/^\/message\//, /^\/chat\b/, /^\/settings\b/, /^\/prefs\b/, /^\/premium\b/, /^\/coins\b/],
  items: { selector: "#siteTable > .thing[data-fullname], shreddit-post, shreddit-comment, .comment[data-fullname]", keyAttr: "data-fullname" },
  // old.reddit.com walls logged-out visitors (login redirect, reason=lor2, seen 11 Nov 2026), so anonymous
  // reads use www.reddit.com; signed-in reads keep old.reddit.com's server-side pagination (ADR 0012).
  readHosts: { signedIn: "old.reddit.com", anonymous: "www.reddit.com" },
};
