# Runbook: Rotating the RevenueCat Webhook Secret

## Overview

The RevenueCat webhook secret (`REVENUECAT_WEBHOOK_SECRET`) authenticates
incoming subscription events. If this secret leaks it can be used to forge
upgrade events and grant arbitrary accounts free Pro access.

The server supports **zero-downtime rotation** by accepting a second
environment variable (`REVENUECAT_WEBHOOK_SECRET_PREV`) during the changeover
window. Both the old and new secrets are valid simultaneously until RevenueCat
is updated and the old secret is removed.

---

## When to rotate

- The secret has appeared in logs, error pages, a git commit, or any other
  uncontrolled location.
- A team member with access to the secret has left the organisation.
- A suspicious upgrade spike alert has fired (see [Abuse Monitoring](#abuse-monitoring)).
- Routine rotation (recommended every 90 days).

---

## Rotation procedure

### Step 1 — Generate a new secret

Use a cryptographically random value of at least 32 bytes:

```bash
openssl rand -hex 32
```

Keep the output private. This is your `NEW_SECRET`.

### Step 2 — Deploy the new secret alongside the old one

Set **both** environment variables so requests signed with either secret are
accepted during the transition:

| Variable                        | Value       |
|---------------------------------|-------------|
| `REVENUECAT_WEBHOOK_SECRET`     | `NEW_SECRET` |
| `REVENUECAT_WEBHOOK_SECRET_PREV`| current value of `REVENUECAT_WEBHOOK_SECRET` |

Deploy and confirm the server is healthy (check `/health`).

At this point the server accepts both secrets. No requests will be rejected.

### Step 3 — Update the secret in RevenueCat

1. Open the [RevenueCat dashboard](https://app.revenuecat.com).
2. Go to **Project → Integrations → Webhooks**.
3. Edit the webhook that points to your API server.
4. Replace the **Authorization header** value with `NEW_SECRET`.
5. Save. RevenueCat will immediately start sending the new secret.

### Step 4 — Verify

Watch the server logs for one minute. You should see no lines matching:

```
RevenueCat webhook authenticated with the PREVIOUS secret
```

If you still see them, RevenueCat has not fully propagated the change yet —
wait a little longer before proceeding.

### Step 5 — Remove the old secret

Once log output is clean:

```bash
unset REVENUECAT_WEBHOOK_SECRET_PREV
```

Remove the variable from your deployment environment (Replit Secrets, CI/CD
config, etc.) and redeploy. The old secret is now invalid.

---

## Rollback

If you need to revert (e.g. the new value was entered incorrectly):

1. Swap `REVENUECAT_WEBHOOK_SECRET` back to the old value.
2. Clear `REVENUECAT_WEBHOOK_SECRET_PREV`.
3. Revert the secret in the RevenueCat dashboard.

---

## Abuse monitoring

The webhook handler maintains an in-memory sliding-window counter (60 minutes)
of upgrade and downgrade events. A warning is logged when **both** of the
following are true:

- ≥ 10 upgrade events in the last hour
- upgrades ÷ downgrades ≥ 10× (strongly imbalanced toward upgrades)

**Log pattern to alert on:**

```
ALERT: Abnormal upgrade spike detected in the last hour
```

### Responding to a spike alert

1. **Check RevenueCat's event log** for unexpected sources or unusual
   `app_user_id` patterns.
2. **Audit recent Pro upgrades** — query your database for accounts upgraded
   in the last hour and compare against known purchase activity.
3. If abuse is confirmed, **rotate the secret immediately** (see above) to
   stop the attacker from sending further forged events.
4. **Downgrade fraudulent accounts** manually via the database or RevenueCat
   dashboard.
5. File an incident report documenting the timeline and remediation steps.

---

## Environment variables reference

| Variable                         | Required | Description                                                                          |
|----------------------------------|----------|--------------------------------------------------------------------------------------|
| `REVENUECAT_WEBHOOK_SECRET`      | Yes      | Current (active) webhook secret. Requests must match this or the previous secret.   |
| `REVENUECAT_WEBHOOK_SECRET_PREV` | No       | Previous secret, set only during a rotation window. Remove after Step 4 above.      |

---

## Related files

- `artifacts/api-server/src/routes/webhooks.ts` — handler implementation
- `artifacts/api-server/src/routes/__tests__/webhooks.test.ts` — test suite
