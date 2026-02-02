---
name: cron
description: Create and manage scheduled tasks (cron jobs) that send you messages at specified times.
---

# Cron Jobs

Schedule tasks that send you messages at specified times. Jobs are scheduled immediately when created.

## Quick Reference

```bash
lettabot-cron list                    # List all jobs
lettabot-cron create [options]        # Create job
lettabot-cron delete ID               # Delete job
lettabot-cron enable ID               # Enable job
lettabot-cron disable ID              # Disable job
```

## Create a Job

```bash
lettabot-cron create \
  --name "Morning Briefing" \
  --schedule "0 8 * * *" \
  --message "Good morning! Review tasks for today." \
  --deliver telegram:123456789
```

**Options:**
- `-n, --name` - Job name (required)
- `-s, --schedule` - Cron expression (required)  
- `-m, --message` - Message sent to you when job runs (required)
- `-d, --deliver` - Where to send response (format: `channel:chatId`). **Defaults to last messaged chat.**
- `--disabled` - Create disabled

## Message Format

When a cron job runs, you receive a message like:

```
[cron:cron-123abc Morning Briefing] Good morning! Review tasks for today.
Current time: 1/27/2026, 8:00:00 AM (America/Los_Angeles)
```

This tells you:
- The message came from a cron job (not a user)
- The job ID and name
- The current time

## Cron Schedule Syntax

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)  
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
* * * * *
```

| Pattern | When |
|---------|------|
| `0 8 * * *` | Daily at 8:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `30 17 * * 5` | Fridays at 5:30 PM |
| `0 0 1 * *` | First of month at midnight |

## Examples

**Daily morning check-in (delivered to Telegram):**
```bash
lettabot-cron create \
  -n "Morning" \
  -s "0 8 * * *" \
  -m "Good morning! What's on today's agenda?" \
  -d telegram:123456789
```

**Weekly review (delivered to Slack):**
```bash
lettabot-cron create \
  -n "Weekly Review" \
  -s "0 17 * * 5" \
  -m "Friday wrap-up: What did we accomplish?" \
  -d slack:C1234567890
```

## Notes

- Jobs schedule immediately when created (no restart needed)
- Use `lettabot-cron list` to see next run times and last run status
- Jobs persist in `cron-jobs.json`
- Logs written to `cron-log.jsonl`
