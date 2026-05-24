## Table of Contents
- [Scheduled Start/Stop · EBS Snapshots · pgBackRest PITR](#scheduled-startstop--ebs-snapshots--pgbackrest-pitr)
- [Global Variables](#global-variables)
- [Part 1: Scheduled Start/Stop via EventBridge Scheduler](#part-1-scheduled-startstop-via-eventbridge-scheduler)
- [Part 2: EBS Daily Snapshots via AWS Data Lifecycle Manager](#part-2-ebs-daily-snapshots-via-aws-data-lifecycle-manager)
- [Part 3: pgBackRest + S3 Point-in-Time Recovery](#part-3-pgbackrest--s3-point-in-time-recovery)
- [Summary](#summary)

# EC2 Operations Guide
## Scheduled Start/Stop · EBS Snapshots · pgBackRest PITR
[back to top ↩](#table-of-contents)
### PostgreSQL 17 / Ubuntu 24.04 / Podman

---

## Global Variables
[back to top ↩](#table-of-contents)

Set these once. All sections reference them.

```bash
# ── Instance ───────────────────────────────────────────────────
instance_id="i-0123456789abcdef0"
region="us-east-1"
account_id="123456789012"

# ── Scheduler (start/stop) ─────────────────────────────────────
scheduler_role_name="eventbridge_ec2_scheduler_role"
scheduler_policy_name="eventbridge_ec2_scheduler_policy"
stop_schedule_name="stop_ec2_instance"
start_schedule_name="start_ec2_instance"
timezone="America/New_York"
stop_cron="cron(0 22 ? * MON-FRI *)"    # 10 PM weekdays (timezone above)
start_cron="cron(0 8 ? * MON-FRI *)"    # 8 AM weekdays  (timezone above)

# ── EBS Snapshots (DLM) ────────────────────────────────────────
dlm_role_name="dlm_snapshot_role"
retain_count=7          # days of daily snapshots to keep
snapshot_time="03:00"   # UTC -- runs while instance is stopped overnight

# ── pgBackRest + S3 ────────────────────────────────────────────
pg_container_name="postgres"
pg_version="17"
pg_data_dir="/opt/pgdata/data"          # host bind-mount path
pg_password="your_secure_password"
s3_bucket_name="your-pgbackrest-bucket"
pgbackrest_iam_role_name="ec2_pgbackrest_s3_role"
pgbackrest_iam_policy_name="pgbackrest_s3_policy"
stanza_name="main"
```

> **AWS CLI region:** all commands below pass `--region "$region"` explicitly.
> IAM commands are global and do not require a region flag.

---

## Part 1: Scheduled Start/Stop via EventBridge Scheduler
[back to top ↩](#table-of-contents)

### 1.1 Create IAM Role and Policy

```bash
# -- Write trust policy ─────────────────────────────────────────
cat > /tmp/scheduler_trust_policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "scheduler.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

# -- Write permissions policy ───────────────────────────────────
cat > /tmp/scheduler_ec2_policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:StartInstances", "ec2:StopInstances"],
    "Resource": "arn:aws:ec2:${region}:${account_id}:instance/${instance_id}"
  }]
}
EOF

# -- Create role ────────────────────────────────────────────────
aws iam create-role \
  --role-name "$scheduler_role_name" \
  --assume-role-policy-document file:///tmp/scheduler_trust_policy.json

# -- Create and attach policy ───────────────────────────────────
scheduler_policy_arn=$(aws iam create-policy \
  --policy-name "$scheduler_policy_name" \
  --policy-document file:///tmp/scheduler_ec2_policy.json \
  --query 'Policy.Arn' \
  --output text)

aws iam attach-role-policy \
  --role-name "$scheduler_role_name" \
  --policy-arn "$scheduler_policy_arn"

# -- Retrieve role ARN ──────────────────────────────────────────
scheduler_role_arn=$(aws iam get-role \
  --role-name "$scheduler_role_name" \
  --query 'Role.Arn' \
  --output text)
```

### 1.2 Create Stop and Start Schedules

```bash
# -- Build target JSON (jq handles nested encoding) ─────────────
stop_target=$(jq -n \
  --arg role_arn "$scheduler_role_arn" \
  --arg instance_id "$instance_id" \
  '{
    Arn: "arn:aws:scheduler:::aws-sdk:ec2:stopInstances",
    RoleArn: $role_arn,
    Input: ({"InstanceIds": [$instance_id]} | tostring)
  }')

start_target=$(jq -n \
  --arg role_arn "$scheduler_role_arn" \
  --arg instance_id "$instance_id" \
  '{
    Arn: "arn:aws:scheduler:::aws-sdk:ec2:startInstances",
    RoleArn: $role_arn,
    Input: ({"InstanceIds": [$instance_id]} | tostring)
  }')

# -- Create stop schedule ───────────────────────────────────────
aws scheduler create-schedule \
  --region "$region" \
  --name "$stop_schedule_name" \
  --schedule-expression "$stop_cron" \
  --schedule-expression-timezone "$timezone" \
  --flexible-time-window '{"Mode": "OFF"}' \
  --target "$stop_target"

# -- Create start schedule ──────────────────────────────────────
aws scheduler create-schedule \
  --region "$region" \
  --name "$start_schedule_name" \
  --schedule-expression "$start_cron" \
  --schedule-expression-timezone "$timezone" \
  --flexible-time-window '{"Mode": "OFF"}' \
  --target "$start_target"
```

### Cron Expression Reference

EventBridge uses a 6-field cron. Times are interpreted in the `timezone` you
set -- no manual UTC offset required.

```
cron(Minutes  Hours  Day-of-month  Month  Day-of-week  Year)

cron(0 22 ? * MON-FRI *)   # 10 PM, weekdays only
cron(0 8  ? * MON-FRI *)   # 8 AM,  weekdays only
cron(0 22 * * ? *)         # 10 PM, every day
```

### Verify

```bash
aws scheduler list-schedules \
  --region "$region" \
  --query 'Schedules[].{Name:Name,State:State}'
```

---

## Part 2: EBS Daily Snapshots via AWS Data Lifecycle Manager
[back to top ↩](#table-of-contents)

DLM is the purpose-built AWS service for EBS snapshot lifecycle. It handles
scheduling, incremental snapshots, and automatic retention cleanup -- no Lambda
or EventBridge rules required. Targeting is tag-based.

> The `snapshot_time` of 03:00 UTC is intentional. It runs while the instance
> is stopped overnight (10 PM Eastern is 02:00-03:00 UTC), giving the cleanest
> possible on-disk state for the snapshot.

### 2.1 Create DLM Service Role

```bash
aws iam create-role \
  --role-name "$dlm_role_name" \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "dlm.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name "$dlm_role_name" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"

dlm_role_arn=$(aws iam get-role \
  --role-name "$dlm_role_name" \
  --query 'Role.Arn' \
  --output text)
```

### 2.2 Tag the Instance

DLM targets instances by tag. Apply this to the instance you want snapshotted.

```bash
aws ec2 create-tags \
  --region "$region" \
  --resources "$instance_id" \
  --tags Key=dlm_backup,Value=enabled
```

### 2.3 Create the Lifecycle Policy

```bash
cat > /tmp/dlm_policy.json << EOF
{
  "PolicyType": "EBS_SNAPSHOT_MANAGEMENT",
  "ResourceTypes": ["INSTANCE"],
  "TargetTags": [{"Key": "dlm_backup", "Value": "enabled"}],
  "Schedules": [{
    "Name": "daily_snapshot",
    "CreateRule": {
      "Interval": 24,
      "IntervalUnit": "HOURS",
      "Times": ["${snapshot_time}"]
    },
    "RetainRule": {
      "Count": ${retain_count}
    },
    "CopyTags": true
  }]
}
EOF

aws dlm create-lifecycle-policy \
  --region "$region" \
  --description "Daily EBS snapshot - ${retain_count}-day retention" \
  --state ENABLED \
  --execution-role-arn "$dlm_role_arn" \
  --policy-details file:///tmp/dlm_policy.json
```

> DLM snapshots **all attached EBS volumes** on instances matching the tag.
> Snapshots are incremental after the first run.

### Verify

```bash
aws dlm get-lifecycle-policies \
  --region "$region" \
  --query 'Policies[].{ID:PolicyId,State:State,Description:Description}'
```

---

## Part 3: pgBackRest + S3 Point-in-Time Recovery
[back to top ↩](#table-of-contents)

### Architecture

```
PostgreSQL 17 (Podman container -- custom image with pgBackRest from PGDG)
  |
  +-- archive_command --> pgBackRest --> S3 (WAL files, continuous)
  |
  +-- base backup ------> pgBackRest --> S3 (weekly full / daily diff)
       triggered by host systemd timer via `podman exec`

IAM instance profile provides S3 credentials -- no static keys anywhere.
```

---

### 3.1 Verify and Harden Existing S3 Bucket

The bucket already exists. The commands below are all idempotent -- they
confirm the bucket is reachable and apply security hardening without
disturbing existing data or configuration.

```bash
# -- Confirm bucket is accessible and in the expected region ───
aws s3api get-bucket-location \
  --region "$region" \
  --bucket "$s3_bucket_name" \
  --query 'LocationConstraint'

# -- Block all public access (safe to apply to existing bucket) ─
aws s3api put-public-access-block \
  --region "$region" \
  --bucket "$s3_bucket_name" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# -- Enable versioning (safe to enable on existing bucket) ──────
aws s3api put-bucket-versioning \
  --region "$region" \
  --bucket "$s3_bucket_name" \
  --versioning-configuration Status=Enabled

# -- Enable server-side encryption (does not affect existing objects)
aws s3api put-bucket-encryption \
  --region "$region" \
  --bucket "$s3_bucket_name" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}
    }]
  }'
```

> The `get-bucket-location` output should match your `$region` variable
> (or return `null` for `us-east-1`, which is the AWS default). If it
> returns a different region, update `$region` before proceeding -- the
> pgBackRest `repo1-s3-region` setting must match the bucket's actual region.

---

### 3.2 Create IAM Instance Profile for S3 Access

Attaches an IAM role to the EC2 instance so pgBackRest authenticates to S3
via the EC2 instance metadata service -- no static credentials needed.

> If the instance already has an IAM role attached, skip the
> `create-instance-profile` and `associate-iam-instance-profile` steps and
> attach the new S3 policy directly to the existing role instead.

```bash
cat > /tmp/ec2_trust_policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

cat > /tmp/pgbackrest_s3_policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${s3_bucket_name}/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::${s3_bucket_name}"
    }
  ]
}
EOF

aws iam create-role \
  --role-name "$pgbackrest_iam_role_name" \
  --assume-role-policy-document file:///tmp/ec2_trust_policy.json

pgbackrest_policy_arn=$(aws iam create-policy \
  --policy-name "$pgbackrest_iam_policy_name" \
  --policy-document file:///tmp/pgbackrest_s3_policy.json \
  --query 'Policy.Arn' \
  --output text)

aws iam attach-role-policy \
  --role-name "$pgbackrest_iam_role_name" \
  --policy-arn "$pgbackrest_policy_arn"

aws iam create-instance-profile \
  --instance-profile-name "$pgbackrest_iam_role_name"

aws iam add-role-to-instance-profile \
  --instance-profile-name "$pgbackrest_iam_role_name" \
  --role-name "$pgbackrest_iam_role_name"

aws ec2 associate-iam-instance-profile \
  --region "$region" \
  --instance-id "$instance_id" \
  --iam-instance-profile Name="$pgbackrest_iam_role_name"
```

---

### 3.3 Prepare Host Directory Structure

Run on the EC2 host as root or with sudo.

```bash
sudo mkdir -p \
  "$pg_data_dir" \
  /etc/pgbackrest \
  /var/log/pgbackrest \
  /var/spool/pgbackrest

# UID 999 = postgres user inside the official postgres:17 container
sudo chown -R 999:999 \
  "$pg_data_dir" \
  /var/log/pgbackrest \
  /var/spool/pgbackrest

sudo chmod 750 \
  "$pg_data_dir" \
  /var/log/pgbackrest \
  /var/spool/pgbackrest

sudo chown root:999 /etc/pgbackrest
sudo chmod 750 /etc/pgbackrest
```

---

### 3.4 Migrate Existing PostgreSQL Data

If PostgreSQL is already running with a named Podman volume, migrate that data
to the new bind-mount path before proceeding.

> Replace `pgdata` below with your actual volume name.
> Run `podman volume ls` to list existing volumes if unsure.

```bash
existing_volume_name="pgdata"   # replace with your actual volume name

current_data_path=$(podman volume inspect "$existing_volume_name" \
  --format '{{.Mountpoint}}' 2>/dev/null)

if [ -n "$current_data_path" ]; then
  podman stop "$pg_container_name"
  sudo cp -a "${current_data_path}/." "$pg_data_dir/"
  sudo chown -R 999:999 "$pg_data_dir"
  echo "Data migrated from $current_data_path to $pg_data_dir"
else
  echo "Volume '$existing_volume_name' not found -- skipping migration"
fi
```

---

### 3.5 Build Custom Container Image

The official `postgres:17` image (Debian bookworm) does not include pgBackRest.
The default Debian apt package is version 2.50, which predates PostgreSQL 17
support. The Dockerfile below installs pgBackRest from the official PGDG apt
repository, which provides version 2.52+ (the minimum required for PG17).

```bash
cat > /tmp/Dockerfile.postgres << EOF
FROM postgres:${pg_version}

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -sSf -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
       https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends pgbackrest \
    && rm -rf /var/lib/apt/lists/*
EOF

podman build \
  -f /tmp/Dockerfile.postgres \
  -t "postgres-pgbackrest:${pg_version}"

# Confirm pgBackRest version is 2.52 or higher
podman run --rm "postgres-pgbackrest:${pg_version}" pgbackrest version
```

---

### 3.6 Configure pgBackRest

```bash
sudo tee /etc/pgbackrest/pgbackrest.conf > /dev/null << EOF
[global]
repo1-type=s3
repo1-path=/pgbackrest/${stanza_name}
repo1-s3-bucket=${s3_bucket_name}
repo1-s3-endpoint=s3.amazonaws.com
repo1-s3-region=${region}
repo1-s3-key-type=auto          # uses EC2 instance profile -- no static keys

repo1-retention-full=2          # keep 2 full backups
repo1-retention-diff=7          # keep 7 differentials

log-level-console=info
log-level-file=detail
log-path=/var/log/pgbackrest

start-fast=y                    # begin backup at next checkpoint, don't wait
archive-async=y                 # non-blocking WAL push
spool-path=/var/spool/pgbackrest

process-max=2                   # adjust to instance vCPU count

[${stanza_name}]
pg1-path=/var/lib/postgresql/data
pg1-port=5432
pg1-user=postgres
EOF

sudo chown root:999 /etc/pgbackrest/pgbackrest.conf
sudo chmod 640 /etc/pgbackrest/pgbackrest.conf
```

---

### 3.7 Recreate the Podman Container

Stop the existing container and recreate it with the required bind mounts.

> `--network=host` allows pgBackRest inside the container to reach the EC2
> instance metadata service (169.254.169.254) to obtain IAM role credentials.

```bash
podman stop "$pg_container_name" 2>/dev/null || true
podman rm   "$pg_container_name" 2>/dev/null || true

podman run -d \
  --name "$pg_container_name" \
  --network host \
  -e POSTGRES_PASSWORD="$pg_password" \
  -e PGDATA=/var/lib/postgresql/data \
  -v "${pg_data_dir}:/var/lib/postgresql/data" \
  -v "/etc/pgbackrest:/etc/pgbackrest:ro" \
  -v "/var/log/pgbackrest:/var/log/pgbackrest" \
  -v "/var/spool/pgbackrest:/var/spool/pgbackrest" \
  --restart unless-stopped \
  "postgres-pgbackrest:${pg_version}"

# Wait for PostgreSQL to accept connections
until podman exec "$pg_container_name" pg_isready -h localhost -p 5432 -q; do
  sleep 2
done
echo "PostgreSQL is ready"
```

---

### 3.8 Configure PostgreSQL WAL Archiving

`archive_mode` cannot be changed with a simple reload -- a full container
restart is required.

```bash
podman exec -u postgres "$pg_container_name" psql -U postgres -c "
  ALTER SYSTEM SET wal_level = 'replica';
  ALTER SYSTEM SET archive_mode = 'on';
  ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=${stanza_name} archive-push %p';
  ALTER SYSTEM SET archive_timeout = 60;
  ALTER SYSTEM SET max_wal_senders = 3;
"

podman restart "$pg_container_name"

# Wait for PostgreSQL to be ready after restart
until podman exec "$pg_container_name" pg_isready -h localhost -p 5432 -q; do
  sleep 2
done

# Verify settings took effect
podman exec -u postgres "$pg_container_name" psql -U postgres -c "
  SELECT name, setting FROM pg_settings
  WHERE name IN (
    'wal_level', 'archive_mode', 'archive_command', 'archive_timeout'
  );
"
```

---

### 3.9 Initialize the pgBackRest Stanza

Creates the required S3 directory structure and validates the full pipeline.

```bash
podman exec -u postgres "$pg_container_name" \
  pgbackrest --stanza="$stanza_name" stanza-create

# Validates: PostgreSQL connection, WAL archiving end-to-end, S3 access
podman exec -u postgres "$pg_container_name" \
  pgbackrest --stanza="$stanza_name" check
```

A passing `check` confirms pgBackRest can connect to PostgreSQL, archive a
test WAL segment to S3, and read it back. Do not proceed to the first backup
until this passes cleanly.

---

### 3.10 Take the First Full Backup

```bash
podman exec -u postgres "$pg_container_name" \
  pgbackrest --stanza="$stanza_name" --type=full --log-level-console=info backup

# Review backup inventory
podman exec -u postgres "$pg_container_name" \
  pgbackrest --stanza="$stanza_name" info
```

---

### 3.11 Schedule Automated Backups with Systemd

> **Timing note:** The backup timer fires at 01:00 UTC (~8-9 PM Eastern),
> before the 10 PM Eastern instance stop. The `Persistent=true` timer option
> is a safety net -- if the instance happens to be off at 01:00 UTC, the
> backup runs automatically on next startup.

**Backup script** -- full on Sunday, differential every other day:

```bash
sudo tee /usr/local/bin/pgbackrest_backup.sh > /dev/null << EOF
#!/bin/bash
pg_container_name="${pg_container_name}"
stanza_name="${stanza_name}"
day_of_week=\$(date +%u)   # 1=Monday, 7=Sunday

if [ "\$day_of_week" -eq 7 ]; then
  backup_type="full"
else
  backup_type="diff"
fi

podman exec -u postgres "\$pg_container_name" \
  pgbackrest --stanza="\$stanza_name" --type="\$backup_type" backup

exit \$?
EOF

sudo chmod +x /usr/local/bin/pgbackrest_backup.sh
```

**Systemd service unit:**

```bash
sudo tee /etc/systemd/system/pgbackrest_backup.service > /dev/null << 'EOF'
[Unit]
Description=pgBackRest scheduled backup
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pgbackrest_backup.sh
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

**Systemd timer unit:**

```bash
sudo tee /etc/systemd/system/pgbackrest_backup.timer > /dev/null << 'EOF'
[Unit]
Description=Run pgBackRest backup daily at 01:00 UTC

[Timer]
OnCalendar=*-*-* 01:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

**Enable and start:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pgbackrest_backup.timer

# Confirm active
sudo systemctl list-timers pgbackrest_backup.timer
```

---

### 3.12 Verify Backup Integrity

```bash
podman exec -u postgres "$pg_container_name" \
  pgbackrest --stanza="$stanza_name" --log-level-console=info verify
```

---

### 3.13 Point-in-Time Restore

> Run this on a recovery instance, not on the live server. The recovery
> instance must have the same IAM instance profile attached and the same
> pgbackrest.conf deployed to /etc/pgbackrest.

```bash
recovery_target_time="2026-01-01 14:30:00"   # UTC timestamp to recover to

# Stop PostgreSQL
podman stop "$pg_container_name" 2>/dev/null || true

# Clear data directory
sudo rm -rf "${pg_data_dir:?}/"*

# Restore to target time
podman run --rm \
  --network host \
  -u postgres \
  -v "${pg_data_dir}:/var/lib/postgresql/data" \
  -v "/etc/pgbackrest:/etc/pgbackrest:ro" \
  -v "/var/log/pgbackrest:/var/log/pgbackrest" \
  -v "/var/spool/pgbackrest:/var/spool/pgbackrest" \
  "postgres-pgbackrest:${pg_version}" \
  pgbackrest --stanza="$stanza_name" \
    --type=time \
    --target="$recovery_target_time" \
    --target-action=promote \
    restore

# Start PostgreSQL -- WAL replay to target time begins automatically
podman start "$pg_container_name"

# Monitor recovery progress
podman logs -f "$pg_container_name"

# Confirm promotion complete -- should return false
podman exec -u postgres "$pg_container_name" \
  psql -U postgres -c "SELECT now(), pg_is_in_recovery();"
```

---

## Summary
[back to top ↩](#table-of-contents)

### What Gets Deployed

| Component | Service | Frequency | Purpose |
|---|---|---|---|
| Start/stop schedule | EventBridge Scheduler | Weekdays 8 AM / 10 PM ET | Cost savings |
| EBS snapshot | AWS DLM | Daily 3 AM UTC (instance off) | Full instance recovery |
| WAL archiving | pgBackRest -> S3 | Continuous (~60s lag) | PITR to any second |
| Diff backup | pgBackRest -> S3 | Daily 1 AM UTC (Mon-Sat) | Faster restores |
| Full backup | pgBackRest -> S3 | Weekly 1 AM UTC (Sun) | Backup anchor |

### Daily Timeline

```
 8:00 AM ET  |  Instance starts       (EventBridge Scheduler)
~8-9 PM ET   |  pgBackRest backup     (systemd timer at 01:00 UTC)
10:00 PM ET  |  Instance stops        (EventBridge Scheduler)
~3:00 AM UTC |  EBS snapshot taken    (DLM -- instance is off, cleanest state)
```

### Rough Monthly Cost Estimate (50 GB database)

| Component | Est. Cost/Month |
|---|---|
| EBS snapshots (DLM, 7-day retention) | $3-6 |
| S3 storage -- full + diffs + WAL | $2-8 |
| S3 PUT requests -- WAL segments | $0.50-2 |
| **Total** | **~$6-16** |

WAL storage cost scales with write activity. A low-traffic database generates
minimal WAL; a high-throughput OLTP workload can generate several GB per hour.
