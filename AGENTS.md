# AGENTS.md

## Upstream Sync (Pseudo Fork)

Use the provided sync script to pull changes from the upstream LettaBot repo.

```
scripts/sync-upstream.sh --merge
```

Notes:
- The script will add `upstream` if missing and merge `upstream/main` into `main`.
- Resolve any conflicts, then push.

## Railway Deployments (Git-Driven)

This repo auto-deploys on git push. Do **not** deploy directly from the Railway CLI.

Flow:
1. Push to `main`.
2. Railway auto-deploys from the repo.

## Railway Logs (Debugging)

When a deployment fails, use the deployment skill to fetch:
- Build logs
- Deploy logs
- Latest failed deployment logs

Reminder: prefer checking logs over guessing. Use the skill’s `railway logs` commands and include timestamps in summaries.
