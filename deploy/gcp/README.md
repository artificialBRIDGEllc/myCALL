# Put myCALL online on Google Cloud (for real customer calls)

About 20 minutes, once. Everything runs from Google's in-browser terminal (Cloud Shell), so there's nothing to install.

**What you get:** a private HTTPS address, protected by a team password, where anyone on the team can drag in a folder of recordings and download a results spreadsheet.

**Cost:** about $20 a month (a small server, 50 GB of storage for recordings, nightly backups), plus Deepgram at roughly $0.26 per hour of audio.

## Before real calls touch it (HIPAA)

Recordings of Medicare calls are protected health information. Before uploading real calls:

1. **Google Cloud BAA.** Console → *IAM & Admin* → *Privacy & Security* → review and accept the HIPAA Business Associate Agreement. It is free and done online. myCALL only uses services the BAA covers: Compute Engine, Cloud Storage disks and snapshots, Secret Manager, Artifact Registry and Cloud Build.
2. **Deepgram BAA.** Ask Deepgram for a signed BAA on your account, and confirm your plan includes one. myCALL already opts every request out of Deepgram's model-training program (`mip_opt_out=true`) so audio isn't kept to train models. Deepgram may price opted-out requests differently; check your plan.
3. **Anthropic BAA (only if you turn on the AI reviewer).** The reviewer sees transcripts with Medicare numbers, SSNs, phone numbers, card numbers, emails and dates removed, but the rest of the call is still health information. Get a BAA from Anthropic before adding the key. Without the key, myCALL still grades every phrase rule and leaves judgment skills for a human.
4. **Only give the password to people allowed to hear the calls.**

## Steps

1. Go to <https://console.cloud.google.com>, sign in, and create a project (top bar → *New project*, name it `mycall`). Add a billing account when asked.
2. Accept the BAA (above).
3. Click the **Cloud Shell** icon (`>_`, top right). A terminal opens in the browser.
4. Paste these three lines:

   ```bash
   gcloud config set project YOUR-PROJECT-ID
   git clone https://github.com/copperlang2007/myCALL.git && cd myCALL
   bash deploy/gcp/setup.sh
   ```

   If GitHub asks you to sign in, use a personal access token as the password (GitHub → *Settings* → *Developer settings* → *Tokens*).
5. When asked, paste the Deepgram API key, then the Anthropic API key (or press Enter to skip the AI reviewer). Both are hidden as you type and go straight into Google Secret Manager, never into a file or the repo. To add the Anthropic key later, rerun the script.
6. Wait about 5 minutes. The script prints:

   ```
   myCALL is live:  https://34-123-45-67.sslip.io
   Team password:   ••••••••••••••••••••••••
   ```

   Send Ryan the address and the password, separately.

**Your own domain (optional):** point a DNS `A` record (e.g. `calls.yourcompany.com`) at the address the script printed, then run `DOMAIN=calls.yourcompany.com bash deploy/gcp/setup.sh`. HTTPS certificates are automatic.

## Update to the latest version

In Cloud Shell: `cd myCALL && git pull && bash deploy/gcp/setup.sh`. It rebuilds and restarts in about 4 minutes, and recordings and grades are kept.

## What the script sets up

| Piece | Why |
|---|---|
| `e2-small` VM (Debian 12, Shielded VM), fixed IP | Runs the app. For heavy batches, rerun with `MACHINE=e2-medium bash deploy/gcp/setup.sh`; it resizes the existing server (about a minute offline). |
| `mycall-data` 50 GB disk, kept if the VM is deleted | Database and recordings. Encrypted at rest by Google. |
| Nightly snapshot, 14 days kept | Backups. |
| Secret Manager: `mycall-deepgram-key`, `mycall-api-token`, optional `mycall-anthropic-key` | Keys never live in files or the repo. |
| Service account `mycall-vm` | Can read only its image and those secrets. |
| Caddy in front of the app | Automatic HTTPS. Only ports 80/443 are open (plus Google's default SSH rule). |

## If something goes wrong

- **Script stops at "Building the app" with a permission error:** in the Console, go to *Cloud Build* → *Settings* and enable the *Service Account User* and *Artifact Registry Writer* roles, then rerun.
- **"Not answering yet":** run `gcloud compute instances get-serial-port-output mycall --zone us-central1-a | tail -50` and send the output to whoever maintains myCALL.
- **Forgot the password:** `gcloud secrets versions access latest --secret mycall-api-token`.
- **Change the password:** `printf %s NEW-PASSWORD | gcloud secrets versions add mycall-api-token --data-file=-`, then rerun `bash deploy/gcp/setup.sh`.
