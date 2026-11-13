#!/usr/bin/env bash
# vm-runner.sh setup | register <name> <labels> | supervise | stop   (on a cloud VM, as a user with passwordless sudo)
#   setup      docker.io, dockerd (no systemd: started here), image herdr-ci-runner:local built from public main's
#              scripts/self-hosted-runner (the same Dockerfile, pins and job-started.sh guard as this PC's runners)
#   register   reads a registration token on stdin (never in argv or env), runs config.sh once in a throwaway container
#              and keeps the runner's credential files in the root-owned docker volume ovis-vm-cred (mode 700, uid 1001)
#   supervise  forever: one fresh container per job (run.sh --once with the credential copied in), alone on its own
#              docker network, tmpfs /w and /tmp, all 4 CPUs, the per-host check caps of a 4-vCPU machine
#   stop       stops the supervisor and the running job container
set -euo pipefail
IMAGE=herdr-ci-runner:local VOL=ovis-vm-cred NET=bridge LOG=$HOME/.ovis-ci/runner.log
mkdir -p "$HOME/.ovis-ci"
dockerd_up() {
  sudo -n docker info >/dev/null 2>&1 && return 0
  (sudo -n nohup dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 60); do sudo -n docker info >/dev/null 2>&1 && return 0; sleep 1; done
  echo "dockerd did not start" >&2; return 1
}
# A job container reaches the internet and nothing of this VM: not the VM's own ports (the vendor's unauthenticated Docker
# API on 2375, sshd, the agent's services, the mesh host), not private ranges or cloud metadata; only DNS to the
# resolver docker gives it. (A user-defined docker network gets no internet in these VMs; the default bridge does.)
firewall() {
  ipt() { sudo -n iptables "$@"; }
  ipt -C INPUT -i docker0 -j DROP 2>/dev/null || ipt -I INPUT -i docker0 -j DROP
  for d in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
    ipt -C DOCKER-USER -i docker0 -d "$d" -j DROP 2>/dev/null || ipt -I DOCKER-USER -i docker0 -d "$d" -j DROP
  done
  # DNS goes through, inserted above the drops: the resolver docker hands a container may sit in a private range
  for pr in udp tcp; do
    ipt -C DOCKER-USER -i docker0 -p "$pr" --dport 53 -j ACCEPT 2>/dev/null || ipt -I DOCKER-USER -i docker0 -p "$pr" --dport 53 -j ACCEPT
  done
}
case "${1:?setup|register|supervise|stop}" in
  setup)
    command -v docker >/dev/null || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null
    dockerd_up
    src=$(mktemp -d); git clone -q --depth 1 https://github.com/devswha/ovis.git "$src"
    t=$SECONDS; sudo -n docker build -q -t "$IMAGE" "$src/scripts/self-hosted-runner" >/dev/null
    echo "image built in $((SECONDS - t)) s from main $(git -C "$src" rev-parse --short HEAD)"; rm -rf "$src"
    firewall
    sudo -n docker volume create "$VOL" >/dev/null
    sudo -n docker run --rm --network none --user 0:0 -v "$VOL:/cred" --entrypoint sh "$IMAGE" -c 'chown 1001:1001 /cred && chmod 700 /cred' ;;
  register)
    name=${2:?name} labels=${3:?labels}; dockerd_up
    # the token is the first line of stdin; it reaches config.sh and nothing else
    sudo -n docker run --rm -i --network "$NET" -v "$VOL:/cred" -e NAME="$name" -e LABELS="$labels" --entrypoint bash "$IMAGE" -c '
      IFS= read -r T; ./config.sh --unattended --disableupdate --url https://github.com/devswha/ovis --token "$T" \
        --name "$NAME" --labels "$LABELS" --work /w --replace >/tmp/config.log 2>&1 || { tail -3 /tmp/config.log; exit 1; }
      unset T; cp .runner .credentials .credentials_rsaparams /cred/ && chmod 600 /cred/.runner /cred/.credentials /cred/.credentials_rsaparams && echo "registered $NAME ($LABELS)"' ;;
  supervise)
    # a job container that ends non-zero (a failed or cancelled job) must not end the loop: no set -e from here on
    set +e
    dockerd_up
    echo "$$" > "$HOME/.ovis-ci/runner.pid"
    while :; do
      dockerd_up || { sleep 30; continue; }
      firewall
      echo "$(date -u +%FT%TZ) job container start" >> "$LOG"
      sudo -n docker run --rm --name ovis-vm-job --network "$NET" --cpuset-cpus "0-$(( $(nproc) - 1 ))" --shm-size 2g \
        --pids-limit 8192 --ulimit core=0 --security-opt no-new-privileges --cap-drop ALL \
        --tmpfs /w:rw,exec,nosuid,size=4g,uid=1001,gid=1001,mode=0755 --tmpfs /tmp:rw,exec,nosuid,size=4g,mode=1777 \
        -e CHECK_HOST_MAX_RUNS=2 -e CHECK_HOST_TEST_SHARDS=3 -e CHECK_HOST_BROWSER_WORKERS=3 -e CHECK_HOST_UNIT_WORKERS=4 \
        -v "$VOL:/cred:ro" --entrypoint bash "$IMAGE" \
        -c 'cp /cred/.runner /cred/.credentials /cred/.credentials_rsaparams . && exec ./run.sh --once </dev/null' >> "$LOG" 2>&1
      rc=$?
      echo "$(date -u +%FT%TZ) job container exit $rc" >> "$LOG"
      sleep 3
    done ;;
  stop)
    [ -f "$HOME/.ovis-ci/runner.pid" ] && kill "$(cat "$HOME/.ovis-ci/runner.pid")" 2>/dev/null || true
    sudo -n docker rm -f ovis-vm-job >/dev/null 2>&1 || true; rm -f "$HOME/.ovis-ci/runner.pid"; echo stopped ;;
esac
