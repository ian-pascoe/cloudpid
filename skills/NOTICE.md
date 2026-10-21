# Notices

These skills are copies of the owner's local pi skills (`~/.pi/agent/skills`, which links into `~/.agents/skills`),
refreshed with `node scripts/sync-skills.mjs`. Do not edit them here: the next sync overwrites the change. The script
leaves out each skill's `agents/` metadata and, for `impeccable`, its font index, browser bundle and screenshot
library (`EXCLUDED_PATHS`); everything else is verbatim.

Attribution and licences stay where the skills declare them:

- `convert-documents-to-markdown`: MIT, by firecrawl (its frontmatter).
- `improve`: MIT, by shadcn (its frontmatter).
- `research/blocked-page-recovery`, `research/rss-feeds`: MIT, by Hermes Agent and Teknium (their frontmatter).
- `pr`: the Summary section's visuals come from Dex Horthy's `show-me` (`pr/CREDITS.md`).

The other skills carry no licence file in the owner's copy. Some derive from public skill collections
(`setup-matt-pocock-skills`, `impeccable`, `ast-grep`); their upstream licences were not checked when this was
written, so check them before this repository is made public.
