# Backup and recovery - Platino RECD Tracker

Status: **the production database (Supabase project `Platino-RECD-`, region ap-south-1) is on Supabase's Free plan.** Nothing in this repository can
change that; it is a decision for the account owner. This document says what that means, what must be decided before real data is entered, and
how to take and test a backup yourself.

## 1. What the Free plan means (verify in the Supabase dashboard, they change their terms)
- **No point-in-time recovery.** If rows are deleted or damaged you cannot "go back to 14:32".
- **Automatic backups are not guaranteed on Free** (Supabase documents daily backups for paid plans). Treat the Free plan as having NO backup unless the
  dashboard (Project -> Database -> Backups) shows backups with dates.
- **Free projects can be paused after a period of inactivity.** A paused database means the live site cannot log anybody in until it is restored.
- Only two free projects per organisation are allowed (one is production).

## 2. Decision needed from the project owner (before real customers)
Pick one and tell the developer:
1. **Upgrade the Supabase organisation to Pro** (paid) - gives daily backups and removes the pause. Recommended for real use.
2. **Stay on Free and take your own backups** (section 3) at least daily, stored OUTSIDE Supabase and outside this repository, and keep the project awake.
3. Move the database elsewhere (needs a separate plan; nothing is assumed here).

## 3. Taking a backup yourself (works on any plan)
Needs PostgreSQL's `pg_dump` (version 17 or newer, to match the server) and the **session pooler** connection string from
Supabase -> Project Settings -> Database -> Connection string -> "Session pooler" (it works over IPv4). Keep that string private.

```bash
# Run from a private folder that is NOT inside the git repository.
export PGSSLMODE=require
pg_dump "$SUPABASE_SESSION_POOLER_URL" --format=custom --no-owner --no-privileges --file="platino-$(date +%F).dump"
```

- `apps/api/scripts/backupDatabase.sh` does the same and refuses to write inside the repository or print the connection string.
- The dump contains **personal data** (customers, users, signed reports). Store it encrypted and limit who can read it.
- A backup you have never restored is not a backup - do section 4 once, now.

## 4. Proving a backup restores (do this against a throwaway database, never production)
```bash
createdb platino_restore_test                      # any local / disposable PostgreSQL 17
pg_restore --no-owner --dbname=platino_restore_test platino-YYYY-MM-DD.dump
psql platino_restore_test -c 'select count(*) from "User";'
psql platino_restore_test -c 'select count(*) from _prisma_migrations;'   # should equal the number of migration folders
```

## 5. Restoring production (an emergency, owner decision)
1. Stop writes: ask users to stop, or pause the Vercel API project.
2. Restore into a NEW Supabase project (or the paused/empty one) first and check it (counts, newest rows).
3. Only then point the API (`DATABASE_URL`, `DIRECT_URL` in Vercel Production) at it and redeploy. Never restore over the live database blindly.
4. Run `npx prisma migrate status` (with `DIRECT_URL` pointing at the restored database): it must report "Database schema is up to date".

## 6. Things the application already does to limit damage
- Row-level security is on for all tables and the `anon` / `authenticated` roles have no grants (the public Supabase API cannot read or write data).
- Users are deactivated, not deleted; signed service reports, unit history and ticket history are protected by database triggers (cannot be edited or deleted).
- Deleting a customer, site or unit is restricted by foreign keys while history exists.

None of this replaces a backup.
