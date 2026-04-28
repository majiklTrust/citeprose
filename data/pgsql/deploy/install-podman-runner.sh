# ON AWS EC2
cd ~/LinkedIn_Agent/build/postgres
# Phase 1 — install Podman and rootless prerequisites (once per host)
bash scripts/01-install-podman.sh
# If user systemd was not previously reachable, log out and back in here.


# Place configs and bootstrap SQL files at the expected paths, then create
# .env with the database password (see .env.example).

## POST 01-install-podman.sh STEPS
mkdir -p /home/ubuntu/marketing-ai/postgres
cp -rp ~/LinkedIn_Agent/linkedin-agent/data/pgsql/configs /home/ubuntu/marketing-ai/postgres/
cp -rp ~/LinkedIn_Agent/linkedin-agent/data/pgsql/bootstrap /home/ubuntu/marketing-ai/postgres/
read -s -p "postgres password: " PSWD
echo ""
cat >~/LinkedIn_Agent/build/postgres/.env <<<"POSTGRES_PASSWORD=$PSWD"
unset PSWD
chmod 600 ~/LinkedIn_Agent/build/postgres/.env



# Phase 2 — pull image, create volume, start container
bash scripts/02-bootstrap-postgres.sh

### CONFIRM SETTINGS FOR PHASE 2 FAILURE - IF PHASE 2 FAILS
systemctl --user status
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
cat /sys/fs/cgroup/cgroup.controllers
### The user-level cgroup has only memory pids, while the system has cpuset cpu io memory hugetlb pids rdma misc.
### The cpu controller is not delegated, which is why --cpus=1.5 in Phase 2 fails.

### Phase 2 FALURE FIX
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null <<'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF
sudo systemctl daemon-reload

sudo reboot

### VERIFY
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
loginctl show-user "$(id -un)" | grep Linger      # expect: Linger=yes
systemctl --user status >/dev/null && echo OK     # expect: OK


# Phase 2
cd ~/LinkedIn_Agent/build/postgres
export PROJECT_ROOT=/home/ubuntu/LinkedIn_Agent/build/postgres
bash scripts/02-bootstrap-postgres.sh


# Phase 3 — generate systemd user unit for boot persistence
bash scripts/03-generate-systemd-unit.sh

# Phase 4 — verify
bash scripts/04-verify.sh

# ==> Port binding (expect 127.0.0.1:5432)
#   5432/tcp ->
#   [FAIL] bound to localhost only

### FAILURE INVESTIGACTION
# Confirm the actual binding is correct:
# Expected output: 5432/tcp -> 127.0.0.1:5432. If you see that, the container is bound correctly and the failure is purely cosmetic.
podman port marketing_ai_instance

# Also confirm from the host side:
# Expected: a listener on 127.0.0.1:5432 only (not 0.0.0.0:5432 or *:5432). If 127.0.0.1 is the only address shown, you're secure.
ss -tlnp | grep 5432

# What went wrong in 04-verify.sh:
# The Go template I used in the script:
# …assumes .NetworkSettings.Ports is populated and structured the way Docker/Podman's REST API returns it. In rootless Podman, port mappings are surfaced under a different field (HostConfig.PortBindings is the more reliable source), and .NetworkSettings.Ports can be empty or differently shaped depending on the network mode (slirp4netns vs. pasta vs. bridge). That's why the script printed 5432/tcp -> with empty IP and port fields, then failed the grep for 127.0.0.1:5432.
# {{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{(index $conf 0).HostIp}}:{{(index $conf 0).HostPort}}{{end}}
podman inspect -f '{{range $p, $bindings := .HostConfig.PortBindings}}{{$p}} -> {{range $bindings}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' marketing_ai_instance
