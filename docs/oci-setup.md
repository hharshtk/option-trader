# Oracle Cloud (OCI) setup

Runbook for the OCI account used to host the option-trader engine. Written 2026-11-15.

> No OCIDs or key contents are stored here on purpose. Look them up with the commands below.

## 1. Account and credits

| | |
|---|---|
| Account type | Free Trial (Universal Credits record) |
| Credit | **SGD 400** |
| Trial window | 2026-11-15 to **2026-12-14** (30 days) |
| Spend so far | SGD 0.00 (only Always Free resources until 2026-11-15) |
| Home region | `ap-hyderabad-1` (single availability domain: `AD-1`) |

What happens on 2026-12-14:

- Unused credits expire; they do not carry over.
- Always Free resources (the Micro VM) keep running.
- Paid resources (the E5 VM) stop being covered. Either upgrade to **Pay As You Go**, or move the work back to a free shape and delete the paid one **before** that date.
- Oracle can reclaim idle Always Free instances (CPU, network and memory all under ~20% for 7 days).

## 2. OCI CLI login

The CLI lives at `/root/bin/oci` (v3.96.2). `/root/bin` is already on PATH via `~/.bashrc`, so use a new shell.

Browser login (session token, short-lived):

```bash
oci session authenticate            # pick home region, sign in, name the profile DEFAULT
export OCI_CLI_AUTH=security_token  # so commands don't need --auth security_token
oci iam region list                 # smoke test
```

Refresh before it expires (about 1 hour by default, 24 hours maximum):

```bash
oci session refresh --profile DEFAULT
```

If it has fully expired, run `oci session authenticate` again.

For unattended use (scripts, a server), switch to an API key instead: `oci setup config`, then upload the public key under *Profile → API keys → Add API key*, then `oci setup repair-file-permissions --file ~/.oci/config`.

Handy lookups:

```bash
# tenancy OCID (also the root compartment)
awk -F= '/^tenancy/{gsub(/ /,"",$2);print $2}' ~/.oci/config

# instances
oci compute instance list --compartment-id <tenancy-ocid> --all \
  --query 'data[].{name:"display-name",state:"lifecycle-state",shape:shape,id:id}' --output table

# public IP of an instance
oci compute instance list-vnics --instance-id <instance-ocid> --query 'data[0]."public-ip"' --raw-output
```

## 3. Instances

| | `option-trading` | `option-trading-e5` |
|---|---|---|
| Shape | VM.Standard.E2.1.Micro (Always Free) | VM.Standard.E5.Flex (paid, uses credits) |
| CPU / RAM | 1 OCPU / **1 GB** | 2 OCPU / **16 GB** |
| Boot volume | 47 GB | 100 GB |
| OS | Ubuntu 24.04 | Ubuntu 24.04 |
| Hostname | `algo` | `algo-e5` |
| Private IP | 10.0.0.211 | 10.0.0.53 |
| Public IP | **none** | `140.245.240.9` (ephemeral) |
| Login user | `ubuntu` | `ubuntu` |

Both are in the same public subnet (`10.0.0.0/24`, route `0.0.0.0/0` via an internet gateway). The Micro has no public IP because the option was not ticked at creation. 1 GB RAM is too small for Next.js + DuckDB + the engine together.

The ephemeral public IP stays with the instance across stop/start, but is lost if the instance is terminated. If Dhan needs a static IP whitelisted, attach a **reserved** public IP instead (free while attached to a running instance).

## 4. SSH access

Both instances use the same key pair, created in the Console as `ssh-key-2026-11-15` (private key `.key`, public key `.key.pub`).

### From WSL

```bash
cp /mnt/c/Users/harsh/Downloads/ssh-key-2026-11-15.key ~/.ssh/oci_option_trading.key
chmod 600 ~/.ssh/oci_option_trading.key
ssh -i ~/.ssh/oci_option_trading.key ubuntu@140.245.240.9
```

The `chmod 600` matters: files under `/mnt/c` look world-readable and SSH refuses them.

### From Windows / VS Code Remote-SSH

Add to `C:\Users\harsh\.ssh\config`:

```
Host oci-option-trading
    HostName 140.245.240.9
    User ubuntu
    IdentityFile C:\Users\harsh\.ssh\ssh-key-2026-11-15.key
    IdentitiesOnly yes
```

Put the key where the config points and lock down its permissions (PowerShell):

```powershell
Copy-Item "$env:USERPROFILE\Downloads\ssh-key-2026-11-15.key" "$env:USERPROFILE\.ssh\"
icacls "$env:USERPROFILE\.ssh\ssh-key-2026-11-15.key" /inheritance:r /grant:r "${env:USERNAME}:R"
ssh oci-option-trading
```

Then in a regular Windows VS Code window (not one attached to WSL): `F1` → **Remote-SSH: Connect to Host…** → `oci-option-trading` → choose **Linux**. The first connect installs the VS Code server on the VM.

Use `ForwardAgent yes` only if you need the VM to use your local keys (for example `git pull` from GitHub), and only on servers you trust.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Permission denied (publickey)` | The private key is not at the `IdentityFile` path, or the key does not match. Check the file exists in `C:\Users\harsh\.ssh\`. With `IdentitiesOnly yes`, SSH tries only that file. Run `ssh -v oci-option-trading` and look at the `identity file` and `Offering public key` lines. |
| `UNPROTECTED PRIVATE KEY FILE` / `bad permissions` | Windows: re-run the `icacls` command. WSL: `chmod 600` the key and keep it under `~/.ssh`, not `/mnt/c`. |
| Timeout / connection refused | Instance has no public IP, is stopped, or port 22 is blocked in the subnet's security list. |
| Wrong user | Ubuntu images use `ubuntu`, not `opc`. |
| `Host key verification failed` | The instance was recreated on the same IP. Remove the old line from `known_hosts`. |
| Changed config, old `ec2-biodata` entry gone | The Windows `config` was overwritten when the OCI entry was added. Re-add the AWS host with its `.pem` path if still needed. |

## 5. Capacity findings (2026-11-15)

Checked with the compute capacity report API:

```bash
oci compute compute-capacity-report create \
  --availability-domain cSUi:AP-HYDERABAD-1-AD-1 --compartment-id <tenancy-ocid> \
  --shape-availabilities '[{"instanceShape":"VM.Standard.A1.Flex","instanceShapeConfig":{"ocpus":4,"memoryInGBs":24}}]'
```

| Shape | Result |
|---|---|
| VM.Standard.A1.Flex (Always Free ARM), 1 to 4 OCPU | `OUT_OF_HOST_CAPACITY` |
| VM.Standard.E4.Flex | `OUT_OF_HOST_CAPACITY` |
| VM.Standard.E5.Flex | Available (used) |
| VM.Standard3.Flex | Available |
| VM.Standard.E3.Flex | Available |

The account is allowed A1 and has the quota (41 cores free), but Hyderabad had no hosts at the time. Capacity changes over the day. Upgrading to Pay As You Go (still $0 for free resources) often makes A1 easier to get.

## 6. Open items

- [ ] Confirm VS Code Remote-SSH connects to `oci-option-trading`.
- [ ] Install Node, clone the repo, and set up DuckDB on `option-trading-e5`.
- [ ] Decide on a **reserved public IP** if Dhan requires a whitelisted static IP.
- [x] Port 443 opened (2026-11-15) in the security list and the VM's iptables, for Caddy in front of the engine. See [engine.md](engine.md#reaching-it-from-vercel). No other ports besides 22.
- [ ] Retry an Always Free **A1** instance (script or manual) as the long-term home, then migrate off the paid E5.
- [ ] Before **2026-12-14**: upgrade to Pay As You Go, or move to the free tier and delete `option-trading-e5`.
- [ ] Consider a budget alert so any unexpected charge is flagged.
