# Deployment runbook - hardening branch `hardening/post-audit`

This branch was prepared WITHOUT deploying anything, applying anything to production, or touching production settings. This runbook is the exact
order for the project owner to follow when they decide to release it. Every step that changes production is marked **OWNER**.

## What is in the branch (on top of production's current commit `1b3304d`)
| Change | Production effect |
|---|---|
| Next.js 14.2.35 -> 15.5.29 (admin) | New admin build; React stays 18.3.1 |
| zod 3 -> 4 (api, admin, shared) | Behaviour-checked by tests; one real regression found and fixed (partial updates) |
| nodemailer 9.1.1 -> 10.4.0 | Same SMTP settings, same variable names |
| Cron: one log line per run, constant-time secret check | Makes a run visible in the Vercel log |
| Errors: unknown URL -> JSON 404; oversized body 413; bad encoding 415 | No change for normal use |
| Migration `20261110090000_add_foreign_key_indexes` (33 indexes) | **NOT applied to production.** Faster lists as data grows |
| Migration `20261110091000_function_search_path_hardening` (5 functions) | **NOT applied to production** |
| Scripts: `smtpCheck.ts`, `prodSmoke.ts`, `backupDatabase.sh` | Run by the owner on demand |
| ESLint also covers `test` and `scripts` | Developer tooling only |

## Order of release (OWNER)
1. **Backups first** (`docs/BACKUP_AND_RECOVERY.md`): decide the plan and take + test a backup. Do not apply migrations to a database you cannot restore.
2. **Open a pull request** from `hardening/post-audit` (after pushing it to the fork) and let the mentor review. Merging into the branch Vercel treats as
   production (`feature/my-service-improvements`) deploys BOTH Vercel projects automatically, so merge only when ready to release.
3. **Apply the two migrations to production, before deploying the code** (they are additive and the old code works with them):
   ```bash
   cd apps/api
   # DIRECT_URL = the Supabase SESSION POOLER string (port 5432). Never paste it into chat or commit it.
   DATABASE_URL="$DIRECT_URL" DIRECT_URL="$DIRECT_URL" npx prisma migrate status    # expect: 31 applied, 2 pending
   DATABASE_URL="$DIRECT_URL" DIRECT_URL="$DIRECT_URL" npx prisma migrate deploy
   DATABASE_URL="$DIRECT_URL" DIRECT_URL="$DIRECT_URL" npx prisma migrate status    # expect: Database schema is up to date (33)
   ```
   Check afterwards in Supabase -> Advisors: "function search_path mutable" is gone and "unindexed foreign keys" drops from 63 to 30 (the 30 left are
   deliberate audit columns).
4. **Deploy** (merge triggers it, or `vercel deploy --prod` per project). The API and the admin site share the `@recd/shared` package (zod 4), so deploy
   BOTH from the same commit, API first.
5. **Verify** (`apps/api/scripts/prodSmoke.ts`, below) and watch the next scheduled runs in the Vercel log (cron lines look like
   `{"cron":"service-reminders","ok":true,"ms":412,"sent":0,...}`).
6. **Rollback** if anything is wrong: Vercel -> Deployments -> the previous deployment (`1b3304d`) -> Promote / Instant Rollback, for each project. The
   migrations are additive and can stay; to remove them: `DROP INDEX IF EXISTS` each index and `ALTER FUNCTION ... RESET search_path`.

## Checks the owner must do that no code can do
- **Backups / plan**: section 2 of `docs/BACKUP_AND_RECOVERY.md`.
- **SMTP**: `SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=recdplatino@gmail.com SMTP_PASSWORD=<16-letter app password> npx tsx apps/api/scripts/smtpCheck.ts`
  (logs in only, sends nothing). Requires 2-step verification on the Google account.
- **Login smoke test**: `PLATINO_API_URL=https://platino-recd.vercel.app PLATINO_SMOKE_EMAIL=... PLATINO_SMOKE_PASSWORD=... npx tsx apps/api/scripts/prodSmoke.ts`
  (read-only; if the account must change its password, do that in the admin site first).
- **Vercel settings** (project owner only): Settings -> Git. `createDeployments` reads "disabled" but pushes did create deployments; decide whether a push to
  the production branch should publish automatically. For safe previews: add `NEXT_PUBLIC_API_URL` for the Preview environment and the preview address to
  `CORS_ALLOWED_ORIGINS` ONLY if you accept previews talking to the production API (there is no staging API).
- **WhatsApp**: `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` from the site creator, added in Vercel Production, then redeploy the API.
- **Reminder policy**: stays OFF until a Super Admin saves lead days and escalation hours in Settings.
- **Cron proof**: the next runs are 03:00 / 03:30 / 04:00 / 04:30 UTC. Vercel's log keeps only about an hour, so look soon after, or ask for log drains.
