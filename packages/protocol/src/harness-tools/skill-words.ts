// What the Skill tools' descriptions say, for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Shared definitions): where a Workspace serves a Skill, the limits a Skill passes, and the Session's words about
// the owner's Approval of a change to the Skills kept Global. The Skill checks of the Registry and of the Session's
// `environment_skill_save` (`packages/extensions/src/skill-checks.ts`) take the limits from here, so the words a tool
// says them in are the numbers the checks apply.
// @effect-diagnostics missingPipeableSignature:off

/** Where each Workspace serves a Skill, read-only: `<SKILLS_ROOT>/<name>`. */
export const SKILLS_ROOT = "/workspace/.agents/skills";

/**
 * A Skill's file larger than this is refused: the Registry keeps each text in one SQLite row and each Workspace keeps it
 * as one storage value (as UTF-8 bytes), and a Durable Object's row or value may hold 8 MiB (workerd#7493; Cloudflare's
 * docs still say 2 MB: cloudflare-docs#34502).
 */
export const MAX_FILE_BYTES = 1536 * 1024;

/** A Skill, all its files together, may be this large: every Workspace holds a copy of its Skill set. */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;

/**
 * The most UTF-8 bytes an Environment's Skill set may hold: the whole set goes to a Workspace in one Durable Object
 * call, and each Workspace keeps a copy.
 */
export const MAX_SKILL_SET_BYTES = 8 * 1024 * 1024;

const inMiB = (bytes: number): string => `${bytes / (1024 * 1024)} MiB`;

/** The size limits of a Skill's file, a Skill and a Skill set, as the tools' descriptions say them. */
export const SKILL_SIZE_WORDS = {
  file: inMiB(MAX_FILE_BYTES),
  skill: inMiB(MAX_SKILL_BYTES),
  set: inMiB(MAX_SKILL_SET_BYTES),
} as const;

/**
 * The most Skills one Approval of an install at Global shows. Each is shown with up to `MAX_CARD_CHARS` characters of
 * its files, so the card stays a size the owner can read and a request a Durable Object keeps; more are installed in
 * batches, the agent naming them. The Registry refuses a preview of more before it reads their files.
 */
export const MAX_APPROVED_SKILLS = 10;

/**
 * The most characters of a Skill's files the Approval card shows. A Skill may be far larger, so the card says what it
 * cut, since the owner approves what they can read.
 */
export const MAX_CARD_CHARS = 16_000;

/**
 * What a Session's tool description says of the Approval of a change to the Skills kept Global. It is not the Limits'
 * wording: what must still hold when the owner answers is the Skill, not a setting.
 */
export const SKILL_APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the Skill of the name was saved again, or the folder's files changed, meanwhile, the approval does not apply and you are told to ask again.";

/**
 * What the endpoint's Skill tools say of a change to the Skills kept Global (`docs/architecture/mcp-endpoint.md` → Built so
 * far: S3b-3): the owner approves it in cloudpid, and the call does not wait for them. The words name the owner (never the
 * user), cloudpid and not a Session as where they answer, and only the tool the endpoint serves to follow the request.
 */
export const GLOBAL_SKILL_ASK = `They steer every Session that starts after, so the owner must approve the change, in cloudpid: the call does not wait for them. It answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires (7 days); follow it with approval_wait, which says whether it was approved and applied, declined, or not applied, and on Approve gives the tool's result. Asking again for the same change while one waits answers the same approval_id; at most 10 of yours may wait or be applying at once. Each Environment's Workspaces and spares serve the change from their next readying (an Environment that keeps its own Skill of the name keeps serving that one).`;

/** What a Session's tool description says of the Approval of an install at Global. */
export const INSTALL_APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the Skills shown are installed and recorded as approved; on Decline nothing is installed, and the result carries their reason. A Skill is installed only if it is the one the user was shown (the same folder and files, at the commit shown) and the Skill of its name was not saved again meanwhile; any other is reported, and you are told to ask again.";
