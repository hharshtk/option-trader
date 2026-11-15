# Server setup runbook

How to rebuild the engine server from scratch on a new VM, step by step. Written 2026-11-15 from the setup of `option-trading-e5`. Follow it in order; every step ends with a check.

> **For agents:** run the steps in order and stop at any failed check. Never print, log or commit secrets (`.env.local` values, tokens, keys). Steps marked **[user]** need the person: a browser sign-in, a decision, or a value only they have. Steps marked **[outward]** change what the internet can reach or what Dhan/Vercel see: confirm with the person before running them.

## Contents

1. [What runs where](#what-runs-where)
2. [Before you start](#before-you-start)
3. [Steps](#steps)
4. [Moving from an old VM](#moving-from-an-old-vm)
5. [Final checklist](#final-checklist)
6. [Gotchas found during the first setup](#gotchas-found-during-the-first-setup)
7. [Reference: current values](#reference-current-values)

## What runs where

```
Browser ──► Vercel (Next.js frontend, region bom1)
              │  ENGINE_URL=https://<PUBLIC_IP>, ENGINE_TOKEN
              ▼
           VM <PUBLIC_IP>:443 ── Caddy (Let's Encrypt IP certificate) ──► 127.0.0.1:3100 engine
                                                                           │
                                     Upstash Redis (Dhan access token) ◄───┤
                                     Dhan REST and WebSocket          ◄────┘
```

- **The VM runs only the engine** (`npm run engine`, ideally under systemd) and Caddy. The frontend is deployed to Vercel.
- **Shared services outside the VM** survive a move unchanged: Upstash Redis (holds the Dhan access token), the S3/R2 bucket (option instruments), Vercel, Dhan.
- Details of the engine itself: [engine.md](engine.md). OCI account details: [oci-setup.md](oci-setup.md).

## Before you start

| Need | Notes |
|---|---|
| OCI VM | Ubuntu 24.04, x86_64. Current: VM.Standard.E5.Flex, 2 OCPU / 16 GB, 100 GB boot, region `ap-hyderabad-1`. Anything with ≥ 4 GB RAM works for the engine today |
| A public IP | **Create the new VM with a reserved public IP**, not an ephemeral one. An ephemeral IP can't be converted later without changing address (see [Gotchas](#gotchas-found-during-the-first-setup)) |
| SSH access | User `ubuntu`. Key pair `ssh-key-2026-11-15` (see [oci-setup.md](oci-setup.md#4-ssh-access)) |
| `.env.local` | Copied securely from the old VM, or rebuilt from [.env.example](../.env.example) and the person's secrets. Never paste its values into chat or commit it |
| GitHub access | Repo `https://github.com/hharshtk/option-trader` |

## Steps

### 1. System basics

```bash
sudo apt-get update && sudo apt-get -y upgrade
timedatectl            # check: "System clock synchronized: yes", "NTP service: active"
```

Leave the time zone as UTC. The engine computes IST itself and never uses the server's zone.

**Check:** `timedatectl | grep synchronized` shows `yes`.

### 2. Node.js 26

The engine needs Node 26 (native TypeScript, `zlib` zstd, `node:sqlite`). Install system-wide from NodeSource. Download the script and read it before running it.

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_26.sh
less /tmp/nodesource_26.sh          # should be NodeSource's repository setup script
sudo -E bash /tmp/nodesource_26.sh
sudo apt-get install -y nodejs
```

**Check:**

```bash
node -v      # v26.x
node -e "console.log(typeof require('zlib').zstdCompressSync, !!require('node:sqlite'))"   # function true
```

### 3. Code

```bash
cd ~ && git clone https://github.com/hharshtk/option-trader.git
cd option-trader && npm ci
```

**Check:** `npm test` passes and `npm run typecheck` prints no errors. The shared-modules test also confirms DuckDB's native module loads on this machine.

### 4. `.env.local` [user]

Copy it from the old VM (see [Moving from an old VM](#moving-from-an-old-vm)) or rebuild it from [.env.example](../.env.example). Then lock it down:

```bash
chmod 600 ~/option-trader/.env.local
```

Variables the engine and its setup need (names only):

| Variable | Where the value comes from |
|---|---|
| `DHAN_CLIENT_ID` | Dhan account |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash console. The Dhan access token lives in this Redis, so it carries over automatically |
| `DHAN_ACCESS_TOKEN` | Optional fallback when Redis has no token |
| `ENGINE_URL` | `http://127.0.0.1:3100` (for a web app on the same machine; Vercel uses the HTTPS address) |
| `ENGINE_TOKEN` | Keep the old one to avoid touching Vercel, or generate a new one (below) and update Vercel |
| `S3_*` | Bucket for option instruments (only the web uses it today) |
| `USER_NAME`, `USER_PASSWORD` | Web app login (only the web uses it) |

New engine token, appended without printing it:

```bash
cd ~/option-trader
grep -q '^ENGINE_TOKEN=' .env.local || printf '\nENGINE_URL=http://127.0.0.1:3100\nENGINE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env.local
```

**Check:** `grep -c '^ENGINE_TOKEN=\|^DHAN_CLIENT_ID=\|^UPSTASH_REDIS_REST_URL=' .env.local` prints `3`.

### 5. Run the engine once by hand

```bash
cd ~/option-trader && npm run engine
```

**Check,** in a second terminal:

```bash
T=$(grep '^ENGINE_TOKEN=' .env.local | cut -d= -f2)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3100/v1/status | node -e \
  'const s=JSON.parse(require("fs").readFileSync(0));console.log(s.overall, s.components.map(c=>c.component+":"+c.state).join(" "))'
```

Expect `ok` and every component `ok`. A `token` failure means no Dhan token in Redis or `.env.local`: save one on the web app's Settings page. Stop the engine with Ctrl-C before the next step.

### 6. Engine as a systemd service

```bash
cd ~/option-trader
sudo cp deploy/option-trader-engine.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now option-trader-engine
```

The unit assumes user `ubuntu` and `/home/ubuntu/option-trader`; edit `User=` and `WorkingDirectory=` if those differ.

**Check:** `systemctl is-active option-trader-engine` prints `active`, and `journalctl -u option-trader-engine -n 20` shows `control API listening`. Repeat the curl from step 5.

### 7. OCI CLI [user]

Needed to open the firewall port (step 8) and to look up the public IP. Install for the `ubuntu` user:

```bash
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- \
  --accept-all-defaults --install-dir ~/lib/oracle-cli --exec-dir ~/bin
```

This puts the CLI at `~/bin/oci`. `~/bin` is on PATH only in new login shells; agents should call `~/bin/oci` by full path.

Sign in with a browser session token. The CLI listens on `localhost:8181` for the redirect, so the person's browser must reach that port on the VM (VS Code Remote forwards it automatically; otherwise `ssh -L 8181:localhost:8181 ubuntu@<PUBLIC_IP>`).

```bash
cd ~ && BROWSER=true PYTHONUNBUFFERED=1 ~/bin/oci session authenticate \
  --region ap-hyderabad-1 --profile-name DEFAULT
```

- Agents: run it in the background, read the printed `https://login...` URL from its output and give it to the person.
- `BROWSER=true` stops it from trying to open a browser through VS Code's helper, which delays the URL. `PYTHONUNBUFFERED=1` makes the URL appear in a log file at once.
- The session lasts about 60 minutes. `~/bin/oci session refresh --profile DEFAULT` extends it; after expiry, sign in again.

**Check:** `OCI_CLI_AUTH=security_token ~/bin/oci iam region list --output table` lists regions.

### 8. Open port 443 [outward]

Two firewalls block it: the OCI security list (outside the VM) and iptables (inside it). Open both. Keep 3100 closed: the engine listens on 127.0.0.1 only.

**8a. OCI security list.** An update replaces the whole rule list, so read the current rules, add 443, and write them all back:

```bash
export OCI_CLI_AUTH=security_token
INST=$(curl -s -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/id)
SUBNET=$(~/bin/oci compute instance list-vnics --instance-id "$INST" --query 'data[0]."subnet-id"' --raw-output)
SL=$(~/bin/oci network subnet get --subnet-id "$SUBNET" --query 'data."security-list-ids"[0]' --raw-output)
~/bin/oci network security-list get --security-list-id "$SL" > /tmp/seclist-backup.json    # keep this backup

node -e '
const fs=require("fs");const rules=JSON.parse(fs.readFileSync("/tmp/seclist-backup.json")).data["ingress-security-rules"];
if(!rules.some(r=>r.protocol==="6"&&r["tcp-options"]?.["destination-port-range"]?.min===443))
  rules.push({protocol:"6",source:"0.0.0.0/0","source-type":"CIDR_BLOCK","is-stateless":false,
    description:"HTTPS to Caddy (engine control API)","tcp-options":{"destination-port-range":{min:443,max:443}}});
fs.writeFileSync("/tmp/ingress.json",JSON.stringify(rules));'

ETAG=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/seclist-backup.json")).etag)')
~/bin/oci network security-list update --security-list-id "$SL" \
  --ingress-security-rules file:///tmp/ingress.json --if-match "$ETAG" --force \
  --query 'data."ingress-security-rules"[].{p:protocol,src:source,port:"tcp-options"."destination-port-range".min}' --output table
```

If the subnet has several security lists or uses network security groups, check which one applies before changing anything.

**8b. iptables.** Oracle's Ubuntu image accepts only port 22 and rejects the rest. Insert the 443 rule **before** the final `REJECT`, then save:

```bash
sudo iptables -L INPUT -n --line-numbers          # find the REJECT line number (5 on a fresh image)
sudo iptables -C INPUT -p tcp -m state --state NEW --dport 443 -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

**Check:** the security-list table shows port 443, and `sudo grep 'dport 443' /etc/iptables/rules.v4` prints the rule.

### 9. Caddy with an IP certificate [outward]

Install from Caddy's official repository. Ubuntu's own package (2.6) is too old for Let's Encrypt IP certificates; 2.11.9 is known to work.

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update && sudo apt-get install -y caddy
caddy version
```

Find the public IP and install [deploy/Caddyfile](../deploy/Caddyfile) with it:

```bash
INST=$(curl -s -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/id)
PUBLIC_IP=$(OCI_CLI_AUTH=security_token ~/bin/oci compute instance list-vnics --instance-id "$INST" --query 'data[0]."public-ip"' --raw-output)
echo "$PUBLIC_IP"

cd ~/option-trader
sed "s/ENGINE_PUBLIC_IP/$PUBLIC_IP/g" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy gets the certificate within about 30 seconds. It first tries `http-01` on port 80, which is closed, then succeeds with `tls-alpn-01` on 443:

```bash
sudo journalctl -u caddy --since "-2min" -o cat | grep -E "certificate obtained|error"
```

**Check:**

```bash
T=$(grep '^ENGINE_TOKEN=' .env.local | cut -d= -f2)
curl -s -o /dev/null -w '%{http_code}\n' https://$PUBLIC_IP/v1/status                 # 401
curl -s -o /dev/null -w '%{http_code}\n' https://$PUBLIC_IP/                          # 404
curl -s -H "Authorization: Bearer $T" https://$PUBLIC_IP/v1/status | head -c 80; echo # JSON starting {"protocol":1
echo | openssl s_client -connect $PUBLIC_IP:443 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName -dates
```

The certificate's issuer is Let's Encrypt and its SAN is `IP Address:<PUBLIC_IP>`. It lasts about 6 days; Caddy renews it automatically.

### 10. Vercel [user] [outward]

In the Vercel project's environment variables:

| Variable | Value |
|---|---|
| `ENGINE_URL` | `https://<PUBLIC_IP>` |
| `ENGINE_TOKEN` | The same value as in the VM's `.env.local` |

[vercel.json](../vercel.json) already pins functions to `bom1` (Mumbai). Redeploy after changing variables.

**Check:** the Vercel app's header shows a green **Engine** dot, and `/engine` shows live status and logs.

### 11. Dhan [user] [outward]

Nothing to do for data and REST: the access token comes from Redis. Once order placement exists, Dhan requires the server's IP on its whitelist (`/v2/ip/setIP` or Dhan Web). A whitelisted IP can be changed only once every 7 days, so set it only after the VM's IP is final (reserved).

## Moving from an old VM

1. **Build the new VM** with steps 1–9, using a reserved public IP.
2. **Copy what isn't in git** from the old VM. Run on the new VM:

   ```bash
   OLD=ubuntu@<OLD_PUBLIC_IP>
   scp -p $OLD:option-trader/.env.local ~/option-trader/.env.local && chmod 600 ~/option-trader/.env.local
   rsync -a $OLD:option-trader/data/ ~/option-trader/data/          # engine logs; journals from E2 on (important)
   rsync -a $OLD:option-trader/captures/ ~/option-trader/captures/  # raw feed captures, if any
   ```

   Don't copy `data/engine/engine.lock`; the engine replaces a stale lock anyway.
3. **Stop the old engine** before starting the new one. Dhan allows 5 WebSockets per account, shared by every engine using it: `sudo systemctl disable --now option-trader-engine` on the old VM.
4. **Point Vercel at the new IP** (step 10) and redeploy.
5. **Update Dhan's IP whitelist** if one is set (step 11).
6. **Update the docs:** the IP in [Reference](#reference-current-values), [engine.md](engine.md#reaching-it-from-vercel) and [oci-setup.md](oci-setup.md).

## Final checklist

| Check | Command or place | Expect |
|---|---|---|
| Node | `node -v` | v26.x |
| Tests | `npm test` | all pass |
| Engine service | `systemctl is-active option-trader-engine` | `active` |
| Engine status | curl from step 5 | `ok`, all components ok |
| Firewalls | `sudo grep 'dport 443' /etc/iptables/rules.v4` and the security list | 443 open, 3100 not |
| Caddy | `systemctl is-active caddy` | `active` |
| Public HTTPS | `curl -s -o /dev/null -w '%{http_code}' https://<PUBLIC_IP>/v1/status` from another machine | `401` |
| Port 3100 closed | `curl -m 4 http://<PUBLIC_IP>:3100/v1/status` from another machine | times out |
| Vercel | App header, `/engine` page | green Engine dot, live logs |

## Gotchas found during the first setup

| Gotcha | What to do |
|---|---|
| An ephemeral public IP can't become reserved. Reserving means a new address | Create the VM with a reserved IP. Swapping later cuts SSH sessions to the old address: do it from the OCI Console, then update Caddy, Vercel, SSH config and Dhan |
| Oracle's Ubuntu image has iptables rules that reject everything but port 22 | Opening the security list alone isn't enough: also add the iptables rule before `REJECT` and save it (step 8b) |
| Updating a security list replaces all its rules | Read, append, write back, with a backup and `--if-match` (step 8a) |
| Clients send no SNI to a bare IP, so Caddy failed the TLS handshake with "internal error" | The Caddyfile's `default_sni` fixes it. Keep it |
| Ubuntu's Caddy package is too old for IP certificates | Use Caddy's official repository (step 9) |
| `oci session authenticate` printed nothing for a long time | It was opening the URL through VS Code's browser helper. Use `BROWSER=true PYTHONUNBUFFERED=1` (step 7) |
| The OCI login redirect goes to `localhost:8181` on the VM | The person's browser must reach that port: VS Code port forwarding or `ssh -L 8181:localhost:8181` |
| OCI sessions expire after about an hour | Refresh or sign in again before OCI commands |
| A second engine refuses to start: "already running (pid N)" | Expected: the lock allows one. Stop the hand-started engine before enabling the service |
| `npm` not found | Node isn't installed or isn't on PATH: step 2 |
| Node warned about module type | Fixed by `"type": "module"` in package.json; nothing to do on a fresh clone |
| A Cloudflare CLI (`cf`) is installed under `~/.local/opt/node-v26.13.1-linux-x64/bin/cf` on the first VM | Not part of the setup: the account has no domain, so the IP approach was used instead of a Cloudflare Tunnel. Skip it unless a domain is added later |

## Reference: current values

| Item | Value |
|---|---|
| VM | `option-trading-e5`, hostname `algo-e5`, VM.Standard.E5.Flex 2 OCPU / 16 GB, Ubuntu 24.04 |
| Region | `ap-hyderabad-1`, `AD-1` |
| Public IP | `140.245.240.9` (ephemeral) |
| Private IP | `10.0.0.53` |
| Engine | `127.0.0.1:3100`, data in `~/option-trader/data/engine/` |
| Public engine URL | `https://140.245.240.9` |
| Open ports | 22 (SSH), 443 (Caddy) |
| Node | v26.13 from NodeSource |
| Caddy | v2.11.9 from Caddy's repository; config `/etc/caddy/Caddyfile`, access log `/var/log/caddy/engine-access.log` |
| OCI CLI | `~/bin/oci` v3.96.2, profile `DEFAULT`, session-token auth |
| Vercel region | `bom1` |
| Upstash Redis key | `dhan:access_token` (24-hour expiry) |
