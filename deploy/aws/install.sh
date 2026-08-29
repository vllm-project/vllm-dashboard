#!/bin/bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: install.sh CHECKPOINT_BUCKET WORKER_SECRET_ARN GITHUB_SECRET_ARN" >&2
  exit 2
fi

checkpoint_bucket=$1
worker_secret_arn=$2
github_secret_arn=$3
source_root=$(cd "$(dirname "$0")/../.." && pwd)

if ! id alerting >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /sbin/nologin alerting
fi

python3.12 -m venv /opt/alerting/venv
/opt/alerting/venv/bin/pip install --no-cache-dir "${source_root}/alerting[aws,postgres]"

install -d -m 0755 /opt/alerting/bin /etc/alerting
install -m 0755 "$source_root"/deploy/aws/bin/load-secrets /opt/alerting/bin/load-secrets
install -m 0755 "$source_root"/deploy/aws/bin/render-secret-env /opt/alerting/bin/render-secret-env
install -m 0755 "$source_root"/deploy/aws/bin/run-worker /opt/alerting/bin/run-worker
install -m 0755 "$source_root"/deploy/aws/bin/run-retention /opt/alerting/bin/run-retention
install -m 0644 "$source_root"/deploy/aws/systemd/*.service /etc/systemd/system/
install -m 0644 "$source_root"/deploy/aws/systemd/*.timer /etc/systemd/system/

printf '%s\n%s\n' "$worker_secret_arn" "$github_secret_arn" > /etc/alerting/secret-arns
printf 'ALERTING_CHECKPOINT_BUCKET=%s\nPATH=/usr/local/bin:/usr/bin:/bin\nDISABLE_AUTOUPDATER=1\n' \
  "$checkpoint_bucket" > /etc/alerting/worker.env
chown root:alerting /etc/alerting/secret-arns /etc/alerting/worker.env
chmod 0440 /etc/alerting/secret-arns /etc/alerting/worker.env

printf 'd /run/alerting 0700 alerting alerting -\n' > /usr/lib/tmpfiles.d/alerting.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/alerting.conf
systemctl daemon-reload
systemctl start alerting-control.service
systemctl enable --now alerting-control.timer
systemctl enable --now alerting-retention.timer
