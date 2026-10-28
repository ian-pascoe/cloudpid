// Trimmed samples of what skills.sh answered on 2026-10-28 (curl, no auth), kept as they came, extra fields (weeklyInstalls,
// isOfficial, page, searchType) included: its leaderboard and search are undocumented, so these are the contract the tests
// of `skill-directory.ts` hold it to. Three rows of each; the real pages have 200.
export const LEADERBOARD_SAMPLES = {
  "all-time": {
    skills: [
      {
        source: "vercel-labs/skills",
        skillId: "find-skills",
        name: "find-skills",
        installs: 4088520,
        weeklyInstalls: [101561, 101317, 105144, 103601, 107199, 110524, 121189, 121665],
        isOfficial: true,
      },
      {
        source: "mattpocock/skills",
        skillId: "grill-me",
        name: "grill-me",
        installs: 1451450,
        weeklyInstalls: [62524, 57027, 53625, 48139, 48386, 58939, 52386, 48664],
      },
      {
        source: "heygen-com/hyperframes",
        skillId: "hyperframes-cli",
        name: "hyperframes-cli",
        installs: 1295542,
        weeklyInstalls: [36139, 46204, 85128, 73279, 96486, 146752, 158584, 144957],
      },
    ],
    total: 9911,
    hasMore: true,
    page: 0,
  },
  trending: {
    skills: [
      {
        source: "designed-by-ai/skills",
        skillId: "design-mobile-apps",
        name: "design-mobile-apps",
        installs: 22670,
      },
      { source: "uizze.sh", skillId: "ui-taste", name: "ui-taste", installs: 21547 },
      {
        source: "heygen-com/hyperframes",
        skillId: "hyperframes-cli",
        name: "hyperframes-cli",
        installs: 20961,
      },
    ],
    total: 9985,
    hasMore: true,
    page: 0,
  },
  hot: {
    skills: [
      {
        source: "okx/onchainos-skills",
        skillId: "okx-dapp-discovery",
        name: "okx-dapp-discovery",
        installs: 5,
        installsYesterday: 1,
        change: 4,
      },
      {
        source: "okx/onchainos-skills",
        skillId: "okx-guide",
        name: "okx-guide",
        installs: 5,
        installsYesterday: 1,
        change: 4,
      },
      {
        source: "okx/onchainos-skills",
        skillId: "okx-dex-market",
        name: "okx-dex-market",
        installs: 5,
        installsYesterday: 1,
        change: 4,
      },
    ],
    total: 2156,
    hasMore: true,
    page: 0,
  },
} as const;

export const SEARCH_SAMPLE = {
  query: "grill",
  searchType: "fuzzy",
  searchVersion: "algolia",
  skills: [
    {
      id: "mattpocock/skills/grill-me",
      source: "mattpocock/skills",
      skillId: "grill-me",
      name: "grill-me",
      installs: 1449577,
    },
    {
      id: "mattpocock/skills/grill-with-docs",
      source: "mattpocock/skills",
      skillId: "grill-with-docs",
      name: "grill-with-docs",
      installs: 1241146,
    },
    {
      id: "mattpocock/skills/grilling",
      source: "mattpocock/skills",
      skillId: "grilling",
      name: "grilling",
      installs: 1003569,
    },
  ],
  count: 200,
  duration_ms: 528,
  timings_ms: {
    rate_limit: 49.269539000000805,
    flags: 1.165262000169605,
    visibility: 55.92778899986297,
    retrieval: 406.9539440004155,
    algolia_processing: 410,
    repositories: 109.02065400034189,
    ranking: 10.45180799998343,
    search: 528,
    total: 577.9373389999382,
  },
  provider_duration_ms: 406.9539440004155,
} as const;
