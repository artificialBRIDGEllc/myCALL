#!/usr/bin/env bash
# One-command myCALL setup on Google Cloud. Run it from Google Cloud Shell,
# inside a clone of the myCALL repo:   bash deploy/gcp/setup.sh
# Safe to run again: it skips anything that already exists, rebuilds the app
# image and restarts the server with it.
#
# Optional settings (put them in front of the command):
#   REGION=us-central1  ZONE=us-central1-a  MACHINE=e2-small  DOMAIN=calls.example.com
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}
if [ -z "$PROJECT" ]; then
  echo "Choose your Google Cloud project first:  gcloud config set project YOUR-PROJECT-ID"
  exit 1
fi
REGION=${REGION:-us-central1}
ZONE=${ZONE:-${REGION}-a}
MACHINE=${MACHINE:-e2-small}
DOMAIN=${DOMAIN:-}
NAME=mycall
SA=mycall-vm@$PROJECT.iam.gserviceaccount.com
IMAGE=$REGION-docker.pkg.dev/$PROJECT/mycall/app:latest
exists() { "$@" >/dev/null 2>&1; }
step() { printf '\n==> %s\n' "$*"; }

step "Project $PROJECT, zone $ZONE"
echo "Reminder: accept the Google Cloud HIPAA Business Associate Agreement for this"
echo "account before uploading real calls (Console > IAM & Admin > Privacy & Security)."

step "Turning on the Google Cloud services myCALL uses"
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT"

step "Building the app (about 3 minutes)"
exists gcloud artifacts repositories describe mycall --location "$REGION" --project "$PROJECT" ||
  gcloud artifacts repositories create mycall --repository-format=docker --location "$REGION" --project "$PROJECT"
gcloud builds submit --tag "$IMAGE" --project "$PROJECT" .

step "Storing secrets in Secret Manager"
put_secret() {
  if exists gcloud secrets describe "$1" --project "$PROJECT"; then
    printf %s "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT" >/dev/null
  else
    printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
}
if ! exists gcloud secrets describe mycall-deepgram-key --project "$PROJECT"; then
  DG=""
  while [ -z "$DG" ]; do read -rsp "Paste the Deepgram API key (it stays hidden), then press Enter: " DG; echo; done
  put_secret mycall-deepgram-key "$DG"
fi
NEW_PASSWORD=""
if ! exists gcloud secrets describe mycall-api-token --project "$PROJECT"; then
  NEW_PASSWORD=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 24)
  put_secret mycall-api-token "$NEW_PASSWORD"
fi

step "Giving the server only the permissions it needs"
exists gcloud iam service-accounts describe "$SA" --project "$PROJECT" ||
  gcloud iam service-accounts create mycall-vm --display-name "myCALL server" --project "$PROJECT"
for role in roles/artifactregistry.reader roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
done
for s in mycall-deepgram-key mycall-api-token; do
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
done

step "Network: a fixed address and HTTPS-only firewall rule"
exists gcloud compute addresses describe mycall-ip --region "$REGION" --project "$PROJECT" ||
  gcloud compute addresses create mycall-ip --region "$REGION" --project "$PROJECT"
IP=$(gcloud compute addresses describe mycall-ip --region "$REGION" --project "$PROJECT" --format='value(address)')
exists gcloud compute firewall-rules describe mycall-web --project "$PROJECT" ||
  gcloud compute firewall-rules create mycall-web --allow tcp:80,tcp:443 --target-tags mycall-web --project "$PROJECT"

step "Storage for recordings, with a nightly backup kept 14 days"
exists gcloud compute disks describe mycall-data --zone "$ZONE" --project "$PROJECT" ||
  gcloud compute disks create mycall-data --zone "$ZONE" --size 50GB --type pd-balanced --project "$PROJECT"
exists gcloud compute resource-policies describe mycall-nightly --region "$REGION" --project "$PROJECT" ||
  gcloud compute resource-policies create snapshot-schedule mycall-nightly --region "$REGION" \
    --daily-schedule --start-time 07:00 --max-retention-days 14 --on-source-disk-delete keep-auto-snapshots --project "$PROJECT"
gcloud compute disks add-resource-policies mycall-data --resource-policies mycall-nightly --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1 || true

step "Starting the server"
METADATA="mycall-image=$IMAGE"
[ -n "$DOMAIN" ] && METADATA="$METADATA,mycall-domain=$DOMAIN"
if exists gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT"; then
  gcloud compute instances add-metadata "$NAME" --zone "$ZONE" --project "$PROJECT" \
    --metadata "$METADATA" --metadata-from-file startup-script=deploy/gcp/vm-startup.sh
  gcloud compute ssh "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet --command "sudo google_metadata_script_runner startup"
else
  gcloud compute instances create "$NAME" --zone "$ZONE" --project "$PROJECT" --machine-type "$MACHINE" \
    --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB \
    --address "$IP" --tags mycall-web --shielded-secure-boot \
    --service-account "$SA" --scopes cloud-platform \
    --disk name=mycall-data,device-name=mycall-data,mode=rw,auto-delete=no \
    --metadata "$METADATA" --metadata-from-file startup-script=deploy/gcp/vm-startup.sh
fi

URL="https://${DOMAIN:-${IP//./-}.sslip.io}"
step "Waiting for $URL to come up (first start takes 2-4 minutes)"
for _ in $(seq 60); do
  if curl -fsS --max-time 5 "$URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 10
done
curl -fsS --max-time 5 "$URL/api/health" >/dev/null 2>&1 || {
  echo "Not answering yet. Check the server log with:"
  echo "  gcloud compute instances get-serial-port-output $NAME --zone $ZONE | tail -50"
  exit 1
}

echo
echo "================================================================"
echo " myCALL is live:  $URL"
if [ -n "$NEW_PASSWORD" ]; then
  echo " Team password:   $NEW_PASSWORD"
  echo " (Shown once. Retrieve later with:"
  echo "  gcloud secrets versions access latest --secret mycall-api-token)"
fi
echo "================================================================"
