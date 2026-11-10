# Audit remediation - master checklist

Branch `hardening/post-audit` (cut from production's commit `1b3304d`, nothing pushed, deployed or applied to production).
Statuses: **FIXED AND VERIFIED** (code/tests, locally) | **PREPARED** (ready, needs approval to apply) | **BLOCKED - APPROVAL / OWNER / CREDENTIALS / DECISION**.
"Verified" always means on this machine against the throwaway test database, never production.

## Verification of the branch (clean run, nothing else running)
| Check | Result |
|---|---|
| TypeScript (shared, api, admin, mobile) | no errors |
| ESLint `src test scripts` | 0 problems |
| API unit tests | 640 / 640 |
| API database tests (33 migrations applied to a local test DB) | 351 / 351 |
| Shared / admin / mobile tests | 119 / 147 / 15 - all pass |
| API build, admin build (Next 15.5.29) | succeed |
| `prisma migrate diff` (migrated DB vs `schema.prisma`) | no difference |
| `scripts/prodSmoke.ts` against a local API | 18 / 18 read-only checks pass |
| `npm audit` | 58 findings (was 59): 2 critical (Expo mobile toolchain only), 20 high, 33 moderate, 3 low |

## The checklist
| # | Audit finding | Status | What was done / what is needed |
|---|---|---|---|
| 1 | No database backups / recovery (Supabase Free plan) | **BLOCKED - OWNER** | `docs/BACKUP_AND_RECOVERY.md` + `scripts/backupDatabase.sh` (guard tested). The plan decision (Pro, or self-managed backups) and the DB connection string are the owner's. |
| 2 | Production login and workflows unverified | **BLOCKED - CREDENTIALS** | `scripts/prodSmoke.ts` written and proven on a local API. Needs the owner to run it with a real account. |
| 3 | SMTP delivery unverified | **BLOCKED - CREDENTIALS** | Real `lib/email.ts` + nodemailer 10 verified against a fake SMTP server (login, sender, missing-variable behaviour). `scripts/smtpCheck.ts` logs in without sending; needs the Gmail App Password. |
| 4 | Cron runs invisible | **FIXED (code)**, proof **BLOCKED - APPROVAL** | One log line per run for all four jobs, constant-time secret check shared by all five cron routes. Becomes visible only after deployment. |
| 5 | WhatsApp OTP not configured | **BLOCKED - CREDENTIALS** | Needs the site creator's token and phone-number id in Vercel Production. No code change possible. |
| 6 | Vercel settings (auto-deploy contradiction, preview env, CORS) | **BLOCKED - OWNER** | Account-owner settings; options written in `docs/DEPLOYMENT_RUNBOOK.md`. |
| 7a | R6 escalation differs from the intended policy | **FIXED AND VERIFIED (locally)** | Approved policy implemented 2026-11-10: first reminder 2 days before, due-date reminder, daily after; one escalation 48 h after the due date began (India Standard Time) to the region's Regional Managers (Management only if none); acknowledgement stops nothing. See `docs/HANDOVER.md` section 51. Production is still OFF and not deployed. |
| 7b | R4 signing / report screens missing on mobile | **BLOCKED - BUSINESS DECISION** | The web app covers R4; a mobile screen is a new feature and depends on whether engineers or only customers sign on the phone. |
| 7c | Other documented decisions (public OTP numbers, AMC signer, warranty start, duplicate PO, ticket recipients, site-contact editors) | **BLOCKED - BUSINESS DECISION** | Listed in `docs/HANDOVER.md`; defaults stay as they are. |
| 8 | Next.js critical advisories | **FIXED AND VERIFIED** (15.5.29) | Deployment is **BLOCKED - APPROVAL**. |
| 9a | nodemailer high advisories | **FIXED AND VERIFIED** (10.4.0) | |
| 9b | zod high advisory | **FIXED AND VERIFIED** (4.6.7 in api/admin/shared) | Found and fixed a real regression: zod 4 `.partial()` applies `.default("")`, which would have blanked report fields on a one-field edit (pinned by `zod4Partials.test.ts`). A nested zod 3 copy remains under `@anthropic-ai/sdk` and Next's optional babel plugin (unused at runtime), so `npm audit` still names zod. |
| 10 | Mobile gaps | URL fix done earlier (**FIXED AND VERIFIED**); no device test and no ticket/signing screen: **BLOCKED - BUSINESS DECISION / DEVICE** | |
| 11 | 63 foreign keys without an index | **PREPARED** | Migration `20261110090000_add_foreign_key_indexes` (33 indexes; 30 audit-only columns deliberately skipped) + `@@index` in `schema.prisma`. Applied and checked only on the local DB. Applying to production: **BLOCKED - APPROVAL**. |
| 12 | 5 functions with mutable `search_path` | **PREPARED** | Migration `20261110091000_function_search_path_hardening`. Same approval. |
| 13 | ESLint / code quality | **FIXED AND VERIFIED** | Lint config (done earlier), 8 source errors fixed, tests and scripts brought to 0 problems, lint covers them now. |
| 14 | Auth / API security | **PARTLY FIXED** | Done: constant-time cron secret everywhere; malformed JSON 400; oversized 413; bad encoding 415; JSON 404. Left as they are, with reasons: bcrypt cost 10 (acceptable; 12 slows every serverless login), JSON limit 10 MB (needed for photos). Decision needed: login token lifetime (default 7 days). |
| 15 | Mentor repository has no PR for the 9 newer commits | **BLOCKED - APPROVAL** | Branches exist on the fork; no PR created. |
| 16 | Remaining `npm audit` items | **BLOCKED - APPROVAL** | `shell-quote` / `tar` (Expo SDK 51 toolchain, not deployed) need an Expo SDK upgrade; PostCSS bundled inside Next needs Next 16. |
| 17 | Housekeeping | open | Paused `platino-recd-staging` Supabase project (empty) and the local `~/.platino-staging/staging.env` (generated secrets, no DB password) can be deleted when no longer wanted. |

## Not changed, on purpose
Production data, the production database and its password, the Super Admin account, Vercel settings and variables, WhatsApp configuration, deployments,
the mentor repository, and every business rule.
