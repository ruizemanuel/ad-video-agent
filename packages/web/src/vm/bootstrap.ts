// The script buy runs, as root, when the VM boots: it is the VM's whole start-up. The provider can read it, so the only
// secret it carries is the order's token, which dies in 75 minutes. It installs what Chrome and the render need, puts
// the `worker` user behind a firewall (the metadata server and the private ranges are out of its reach, and with them
// whatever a site makes the browser fetch), downloads the code at one exact commit and starts the worker as that user,
// never as root. Only ports 53/80/443/123 leave the VM and a blocked connection hangs instead of failing, so every
// call that waits on the network has a timeout. The last line it prints is one JSON object: buy's tracking URL shows
// it, and it names the step that failed.

/** Node for the worker: the latest 24.x on 18/10/2026 (v24.22.0 came out on 14/10/2026). */
const NODE_VERSION = 'v24.22.0';

/** What buy accepts as a script. */
const MAX_BYTES = 4096;

export type BootstrapInput = {
  /** Where the service lives, over https: the worker calls `<apiBase>/api/vm/tasks/...`. */
  apiBase: string;
  /** The order's permit, as `issueVmToken` makes it. */
  vmToken: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** A commit (or tag) of the repo: the VM runs exactly this code. */
  ref: string;
};

// What goes into the script is checked against a short list of characters, so no value can end a quote or start a
// command. The script quotes what it can, but this is the check that counts.
const SHAPES = {
  apiBase: { what: 'an https address', shape: /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._-]+)*$/ },
  vmToken: { what: 'a token', shape: /^[A-Za-z0-9_-]{1,200}$/ },
  // The owner has no dots and the name is not "." or "..", so the repo cannot climb out of codeload's path.
  repo: { what: 'owner/name', shape: /^[A-Za-z0-9_-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/ },
  ref: { what: 'a commit or tag', shape: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/ },
} as const;

// The script, with @NAME@ where an input goes. Every `s` is a step: it times it, logs it and, on the first failure,
// keeps its name and the last line it printed (the token taken out before the line is cut, and the rest filtered).
// `R` runs a command as the worker with an empty environment of its own: nothing of root's gets to it. `N` makes the
// worker and its rules, and tries them. The rules go to the top of the chain (-I) so nothing already there can let the
// worker through. The metadata server is closed on port 80 only: its port 53 is the VM's resolver. The self-test in
// `N` fails the step if the worker still reaches the metadata server, and then nothing else runs.
//
// Root keeps running commands after the worker has run code, so none may come from a place the worker can write to:
// root's PATH has system folders only, and Node is unpacked without the archive's owner (the tarball says uid 1001,
// which the worker may well get). In the apt line are the libraries Chrome needs, plus ffmpeg for the video.
//
// The worker starts from its own folder: only @app/vm depends on tsx, so only from there can Node find it.
const TEMPLATE = String.raw`#!/bin/bash
# Order VM start-up, run as root. Out: ports 53/80/443/123 only, and a blocked call hangs: everything has a timeout.
# The only secret here is the order token (75 min). stdout is ONE JSON line: the failed step and the seconds each took.
set -u
cd /
S=$(date +%s);W=/home/worker;L=/root/b.log;T=/root/t;K='@TOKEN@';F=;M=
# Root's PATH has system folders only: Node's folder (and anything the worker may write to) is never searched for root's commands.
export DEBIAN_FRONTEND=noninteractive PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
: >$T
s(){
  local n=$1 a=$(date +%s) r;shift
  echo "== $n $(date -u +%T)">>$L
  "$@">>$L 2>&1;r=$?
  echo "\"$n\":$(($(date +%s)-a))">>$T
  [ $r = 0 ]||{
    [ "$F" ]||{ F=$n;M=$(tail -n1 $L|tr -cd '[:alnum:] ._:/=-'|sed "s/$K//g"|head -c 120);}
    echo "== $n rc=$r">>$L
  }
  return $r
}
# The worker gets an empty environment plus these three: nothing of root's.
R(){ runuser -u worker -- env -i HOME=$W PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@";}
# The worker runs code driven by other people's sites: it may not reach the metadata server or any private network.
N(){
  id worker||useradd -m -s /bin/bash worker||return 1
  local r
  for r in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16;do iptables -I OUTPUT -m owner --uid-owner worker -d $r -p tcp -j REJECT||return 1;done
  iptables -I OUTPUT -m owner --uid-owner worker -d 169.254.169.254 -p tcp --dport 80 -j REJECT||return 1
  # The same address over IPv6, for the VMs that have it.
  ip6tables -I OUTPUT -m owner --uid-owner worker -d fd20:ce::254 -j REJECT
  ! R timeout 5 curl -s -o /dev/null http://169.254.169.254/
}
A='-o DPkg::Lock::Timeout=240 -y -qq --no-install-recommends'
s apt bash -c "timeout 300 apt-get $A update&&timeout 900 apt-get $A install xz-utils ffmpeg iptables fonts-dejavu-core libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 libatk-bridge2.0-0"&&
s node bash -o pipefail -c 'mkdir -p /opt/node&&timeout 180 curl -fsSL https://nodejs.org/dist/@NODE@/node-@NODE@-linux-x64.tar.xz|tar -xJ --no-same-owner --strip-components=1 -C /opt/node&&PATH=/opt/node/bin:$PATH corepack enable'&&
s fw N&&
s fetch R bash -o pipefail -c 'mkdir -p ~/app&&cd ~/app&&timeout 120 curl -fsSL https://codeload.github.com/@REPO@/tar.gz/@REF@|tar -xz --strip-components=1'&&cd $W/app&&
s install R timeout 900 pnpm install --frozen-lockfile --filter @app/vm...&&
cd packages/vm&&
s run R timeout 3300 env API_BASE=@API@ VM_TOKEN=$K node --import tsx src/main.ts
echo "{\"failed\":\"$F\",\"msg\":\"$M\",\"t\":{$(paste -sd, $T),\"total\":$(($(date +%s)-S))}}"
`;

/** The script for one order's VM. It refuses an input that is not a plain address, name or token. */
export function buildBootstrap(input: BootstrapInput): string {
  const values = { ...input, apiBase: input.apiBase.replace(/\/+$/, '') };
  for (const [name, { what, shape }] of Object.entries(SHAPES)) {
    if (!shape.test(values[name as keyof BootstrapInput])) throw new RangeError(`The VM script cannot take that ${name}: it has to be ${what}.`);
  }
  const fill: Record<string, string> = { NODE: NODE_VERSION, TOKEN: values.vmToken, API: values.apiBase, REPO: values.repo, REF: values.ref };
  const script = TEMPLATE.replace(/@([A-Z]+)@/g, (placeholder, name: string) => fill[name] ?? placeholder);
  if (Buffer.byteLength(script) > MAX_BYTES) throw new RangeError(`The VM script is over ${MAX_BYTES} bytes.`);
  return script;
}
