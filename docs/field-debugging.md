# Field debugging: connecting the dashboard to the real SCADA

The real SCADA is reached from a Windows workstation over RDP. That machine has no internet and nobody can supervise it live, so every failure has to be diagnosable from text you copy out of it and paste into a Claude session, and every fix has to come back as something small you can apply by hand. This page is the protocol.

## The loop
1. Something does not work (a source stays offline, readings are stale, a check fails).
2. You build a **report** on the Diagnostics page (or, if the web app is down, run the offline script) and paste it into a Claude session with the message template below.
3. Claude reads the header, finds the first failing step and answers with one of three kinds of fix (see "How a fix comes back").
4. You apply it, build a new report and paste that too.

The report is the only thing that has to travel. It is plain text, it carries the build id of the code that produced it, and it can be checked for truncation.

## Where to install
Install on a plain local folder such as `C:\dcdash`, never inside OneDrive or another synced folder. The project folder holds `.env` (the database password and the key that decrypts the stored source credentials) and the backups, and a cloud sync would copy them off the machine; bind mounts on a synced path can also be slow or locked. `scripts\setup.ps1` and `scripts/setup.sh` print a warning (never an error) when the folder looks like OneDrive, and the offline script's HOST section prints `project folder: <path>` followed by a `WARNING: inside OneDrive` line in that case.

## First connection day: checklist
Ask these before the first real connection; write the answers next to the source in the dashboard's notes or in your own file.
- **Endpoint.** The exact URL and port as seen from the workstation (for example `opc.tcp://host:4840/path`). Is it the OPC UA server itself or a gateway / aggregator in front of it? Cluster-internal host names often do not resolve from Docker on Windows: ask for an address the workstation can reach. The report's `dns lookup <host>` lines (ENVIRONMENT) show whether a source's host name resolves from inside the containers.
- **Security.** Which security policies and modes the server offers (the connection check lists them), and whether anonymous access is allowed. Which one we should use.
- **Account.** A **read-only** account (user name and password) for the dashboard. Never an engineering account.
- **Certificates.** Who trusts whose certificate: our client certificate (the check shows its thumbprint and expiry) must be trusted by the server when a secure policy is used; ask them to trust it, or to tell you where the trust list lives.
- **Network.** Firewall rules from the workstation (or the Docker host) to the server address and port, both directions if the server answers on another port.
- **Refresh rate.** How often the SCADA refreshes values, so polling is not faster than the data (a faster poll only adds load).
- **Fragile devices.** Some PLCs and gateways allow only a few connections or react badly to unexpected traffic. Say so to the SCADA team before you scan, and use a single known host first. Scans can trip intrusion detection: tell the OT security team beforehand and ask who to warn.
- **Clock.** The server and this machine should agree within a few minutes; OPC UA refuses sessions otherwise.

## Produce the report
1. Sign in as an administrator and open **Diagnostics** (Administer menu).
2. Choose **Summary** (start here; one paste, about 12,000 characters at most). Send **Full** (several parts, up to about 60,000 characters) only when Claude asks for it. Use the source selector to limit the report to one source when asked for `source=N`.
3. Tick **Hide host names and addresses** if the report must not show your OT network's addresses. Hosts and IPs are replaced by `HOST-1`, `HOST-2`... consistently through the whole report. The **Address key** (which alias is which host) stays on the page and is never part of the text; keep it to translate Claude's answer back.
4. Press **Build report**. For each part press **Copy part i of n** and paste it, one part per message if there are several. **Download .txt** saves the same text as a file.

Every part starts with `DCDASH-REPORT v1 | PART i OF n | build <id> | <time>` and ends with a footer `--- PART i OF n | chars=N lines=N ---`; the last part ends with `END OF REPORT <checksum>`. `chars=` counts only the content between the header line and the footer (not the header or the footer themselves), so the whole part you paste is a little longer than that number. If the footer or the checksum line is missing in what Claude received, the paste was cut: paste again.

Building a report is recorded in the audit log (who, when, summary or full, masked or not), never its content.

## The connection check
On Diagnostics (and as **Check connection** on a row of the Sources page, for operators too) a check walks one OPC UA source through these steps and shows each one live, with milliseconds and the exact error. A failing step carries a hint in plain words; the steps after it are skipped because they depend on it.

| Step | What it proves | Typical failure and who to ask |
|---|---|---|
| DNS resolution | The host name resolves from here | `getaddrinfo` failed: wrong host name or this machine's DNS; ask the network team |
| TCP connection | The port is open and reachable | refused or timeout: wrong port, firewall, host down; ask the network team |
| Server endpoints | Which security policies, modes and user token types the server offers, and whether ours is among them | configured combination not offered: change the source's security policy or ask the SCADA team |
| Certificates | Our client certificate (subject, thumbprint, expiry) and the server's (subject, expiry, host name match) | expired or host name mismatch: renew, or fix the endpoint URL |
| Secure channel and session | The secure channel opens and the login is accepted | `BadSecurityChecksFailed` / `BadCertificateUntrusted`: the server does not trust our certificate, give them the thumbprint. `BadIdentityTokenRejected` / `BadUserAccessDenied`: the account or password |
| Server time | The server clock against ours | skew over a few minutes breaks OPC UA. Compare with the **browser clock vs container clock** line of the report first: a drifting Docker/WSL2 clock after the host slept is a LOCAL cause |
| Namespaces | The server's namespace table | wrong namespace index in a node id |
| Read the mapped points | One read of every mapped point: value, status, timestamps | `BadNodeIdUnknown`: wrong node id or namespace index; ask the SCADA team |
| Read timing | Five reads, min/avg/max | slow answers: overloaded server or gateway |

The check only reads (DNS, TCP, endpoint discovery, session, Read); it opens one session, never writes to the SCADA, and refuses to start twice at once or within five seconds of the last one.

## The speed check
When a page is slow on an installation, run this in the project folder and paste the whole output back:

    docker compose exec -T api python -m dcdash.diagnostics.speed

About 25 plain lines: how many assets, points, meters and hourly rows there are, and how many seconds one month of energy, Billing, Check month and the Storage page's queries take (each run twice, so a cache shows as a drop; the check switches the figure cache off for its run, so a drop between the two runs is the database's own cache). It only reads, in a read-only transaction (Billing's month is computed on the figure cache's own small connection pool, with read-only statements, outside that transaction and without the statement timeout, so a stalled database can hang that one stage), and prints counts and seconds, never a name, an address or a password. A large database can take a few minutes.

## Reading a report (what Claude looks at)
1. The **header**: build id and time, to know which code produced it.
2. The **LATEST CHECK** line right after it: the failing step and the OPC UA status, or "all steps OK", or "no connection check has been run".
3. **ENVIRONMENT**: versions, the DNS lines and the clock lines. `dns servers: 127.0.0.11` is Docker's embedded resolver: the container cannot see which resolvers it forwards to (those of the Docker host), so compare with the DNS servers in the offline script's NETWORK section. Below it, one `dns lookup <host>: OK in 12 ms -> <addresses>` or `FAILED in 3000 ms: <error>` line per source host that is a name (at most 8, 3 s each, looked up from inside the api container; the collector shares its Docker network and DNS settings, so the answer stands for both), or `dns lookups: none needed (every source host is an address)`. After a failure the report adds why names that only the cluster knows often fail from Docker on Windows. **SOURCES** and **SOURCE HEALTH**: status, last error, reads per minute and error rate. **POINTS**: the worst points. **JOURNAL**: what changed and when (source went offline / came back, bad points, jobs, clock skew). **API ERRORS**, **AUDIT TAIL**, **STORAGE AND RETENTION**, **SCANS**.

## Rehearsing a failure (development simulator only)
Before the real SCADA exists the whole loop can be practised against the OPC UA simulator, which can be told to misbehave. Faults exist ONLY in the simulator (the `simulator` service of the `dev` Compose profile; a production `docker compose up` does not start it, and nothing else in the application reads these variables). Set them for one command, never in `.env`, and look for the line `FAULT INJECTION ACTIVE: ...` in `docker compose logs simulator`: a misspelled variable name never reaches the container and the rehearsal would run without the fault.

    SIM_FAULT_SLOW=1.5 docker compose --profile dev up -d --force-recreate simulator
    docker compose --profile dev logs --tail 5 simulator
    SIM_FAULT_SLOW= docker compose --profile dev up -d --force-recreate simulator    # back to normal

| Variable | What the simulator does | What the check shows |
|---|---|---|
| `SIM_FAULT_POLICIES=basic256sha256` (or `none,basic256sha256`) | offers only the secure policy (a self-signed server certificate is made at start) | a source set to `none` fails at **Server endpoints**: the policy it wants is not offered |
| `SIM_FAULT_UNTRUSTED_CERT=1` | refuses every client certificate the way real servers do: an error at the secure channel, then the connection closes (`=session` refuses later, at the session) | **Secure channel and session** fails with `BadSecurityChecksFailed`; the hint asks the SCADA team to trust our certificate thumbprint |
| `SIM_FAULT_AUTH=required` (+ `SIM_OPCUA_PASSWORD`, user `sim`) | offers only the user name token | no user on the source: **Server endpoints** fails; wrong password: **Secure channel and session** fails with `BadUserAccessDenied` / `BadIdentityTokenRejected` |
| `SIM_FAULT_SLOW=<seconds>` | delays every incoming message by that long | a delay of about a quarter of the source's timeout or more fails the handshake with a timeout (it needs four round trips); smaller delays only show in **Read timing** |
| `SIM_FAULT_DROP=<seconds>` | closes each connection that many seconds after it was accepted | the step that is running then fails with a closed connection, and the journal shows the source going offline and online again |
| `SIM_FAULT_BAD=LVP01_kW:BadSensorFailure,...` | the listed points answer with that Bad status code (a node that exists still browses, which a real server would not allow for `BadNodeIdUnknown`) | **Read the mapped points** names the points and their codes |
| `SIM_FAULT_SKEW=<seconds>` | the server's clock runs that many seconds ahead (negative: behind) | **Server time** warns above 60 s and fails above 300 s with the clock hint |
| `SIM_FAULT_CERT_HOSTS=a.example,b.example` | extra host names in the simulator's server certificate | the certificates step stops reporting "does not name the host" for those names |

`SIM_FAULT_*` applies to the OPC UA server only; the HTTP simulator's own `POST /admin/fault` switch is an older, separate thing. `scripts/e2e.sh` refuses to run while any `SIM_FAULT_*` variable is set. The reports produced against each fault, and what a reader with nothing but the text made of them, are in [field-debugging-examples/](field-debugging-examples/README.md).

## What never to paste
- Screenshots or text that show a password, a token, the `.env` file, or the contents of `certs/` (private keys).
- Anything from the report is already scrubbed (passwords, secret key, session tokens and password hashes are never in it), but the report **does** contain the addresses of an OT network unless you tick the mask option. You decide what leaves the workstation.

## When the web app is down
The offline scripts need no application and no internet. They print and save `dcdash-diag-<time>.txt` (host facts, disk, clock, network adapters, DNS and a TCP connect with milliseconds for each `host:port` you give them, what listens locally and which program owns each port, which tools exist) and, when Docker and the project's `compose.yaml` are there, also container status, the Docker clock, the database, the API health answer and the last 30 log lines of every service (routine lines left out, see below). Their last line `END OF DIAGNOSTICS <checksum>` shows a truncated paste. Copy the text out of the RDP session, or carry the file over RDP drive redirection.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 scada-host:4840 10.0.0.5:502 -ProjectDir C:\dcdash
    bash scripts/collect-diagnostics.sh scada-host:4840 10.0.0.5:502 --project-dir /opt/dcdash

`-ProjectDir` / `--project-dir` is the folder with `compose.yaml` and `.env` (default: the current folder, else the folder above `scripts`). Without Docker or a `compose.yaml` the container sections say so and everything else still works (Windows services named `dcdash*` and `postgres*` are listed instead).

**Where the files go.** Into a `logs` folder inside the project folder (for example `C:\dcdash\logs`; inside the current folder when no project folder is found), created if it is missing. The folder is git-ignored, and the script prints the full path of every file on a `saved:` line. `-OutDir` / `--out-dir` picks another folder and is used as given.

**Two files.** The main report is short enough to paste. The logs file `dcdash-diag-<time>-logs.txt` holds the last 300 kept lines of every service (kept: after the routine lines are dropped, see the next paragraph); it is saved but never printed. Send it only when asked, and read it first: a log line can name hosts, user names and part numbers of your OT network (`-Mask` below hides what the script knows).

**What the log tails leave out.** A busy day buries the failure under health checks, so per service the script reads the last 2000 lines, drops the routine ones and keeps the last 300 (file) and the last 30 (screen). Routine means: access lines with a 2xx or 3xx status (`"GET /api/health HTTP/1.1" 200 OK`), the admin API requests of the web healthcheck, and TimescaleDB's continuous aggregate refresh and checkpoint chatter. A line containing `error`, `warn`, `fatal`, `traceback`, `exception` or `panic` (any case) is never dropped, whatever else it matches; an access line with any other status (`401`, `404`, `500`) is not routine either and stays. The block header says what was dropped, for example `-- api (last 30 of 214 kept lines; dropped 1086 routine lines of 1300 read)`, and the logs file header says the filter was on (`routine lines are dropped`). When 2000 lines were read the header adds `(tail limit reached; older lines not read)`: the interesting minutes may have scrolled out. `-RawLogs` (PowerShell) / `--raw-logs` (shell) switches the filter off and keeps every line; the header then says `unfiltered`.

**Colour codes and the first start of the database.** Some services colour their log lines. Before anything else the script removes the colour codes from the log text (`ESC[32m`, and the same without the ESC character when it was lost on the way: `[0m`, `[37;1m`), so a colour-wrapped health check is still recognised as routine, the counts in the block header are right and the report holds plain text (`-RawLogs` / `--raw-logs` removes the codes too, and still keeps every line). The code without the ESC character needs at least one digit, so text that only looks like a code, such as `[5m]`, `cfg[mode]` or `[main]`, is left alone. The first start of the TimescaleDB image logs two lines that look like failures and are not: `no usable system locales were found` and `background worker ... trying to connect to template database, exiting`. They are never dropped (they hold the word `warning` or `error`), but when the last 300 kept lines of a service hold one of them, the block in the main report starts with one line, `known benign on a first start (Timescale image): ...`, so you can tell them from a real fault. A line like that on a database that has run for days is not first-start noise: tell Claude.

**The DOCKER CLOCK section** (between SERVICES and DATABASE) asks the `db` container for its time and compares it with this computer's clock, read before and after the call: `docker VM minus host = +N s (host utc HH:mm:ss, the docker call took M ms)`, whole seconds, so one second either way is noise. Above 30 s the line adds `Docker/WSL2 clock drift (typical after the host slept), a local cause, not the SCADA`: the Docker VM's clock drifts while a laptop sleeps, and a skewed clock is exactly what makes OPC UA sessions fail (connection check step "Server time"). Restarting Docker Desktop normally brings it back. The section says `skipped (no containers)` when there is no container to ask and `could not read the Docker VM clock (exit code N): <first line>` when containers exist but are stopped or do not answer.

**The LOCAL PORTS section** says, for the three ports this product uses (80 and 443 for the web page, 8000 for the API of a native install), whether something listens there and who it is: `port 80: something is listening on 0.0.0.0, :: (owner: com.docker.backend, pid 5180)`. The owner is a process name and number only, never a command line, a path or a user. Below that, `other listening ports (up to 40):` lists every other listener, one row per process, lowest port first (`  135  0.0.0.0, ::  svchost (pid 2564)`), and `... and N more` when there are more than 40. When the script cannot learn an owner it says `owner hidden` and why: the PowerShell script asks Windows with a 5 second limit (`the lookup did not answer in 5 s`, or `the lookup was refused` when the networking module is missing or blocked); the shell script prints `owner hidden` for a process that belongs to another user (`sudo` shows them, but then the saved files and a new `logs` folder belong to root only, so add `--out-dir` with a folder you own). The section list and its order are unchanged: the report is still `DCDASH-DIAG v1`. How to read it: under Docker Desktop the owner of 80 and 443 is a Docker process (`com.docker.backend`, `wslrelay` or `vpnkit`), not `caddy`; `System (pid 4)` is Windows itself (its HTTP service behind IIS and WinRM, file sharing), and another program on port 80 or 443 (IIS, Skype, a second web server) is why the web container cannot start. `-Mask` hides addresses but not process names, which can name the programs installed on the workstation: read the file before you paste it.

**Hiding names: `-Mask` (PowerShell script only).** `-Mask` replaces what identifies the machine and the OT network with short aliases, consistently through the whole text, so a report can leave a plant that does not want its names out:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 scada-host:4840 -ProjectDir C:\dcdash -Mask

Before it prints anything it collects what it can know: the computer name, the user name, the domain names, every network adapter's DNS suffix, addresses, gateways and DNS servers, the host of each target you gave it (with or without a port), the time source `w32tm` names, and the project and output folders. Hosts, domains and addresses become `HOST-1`, `HOST-2`..., the user name `USER-1`, the folders `PATH-1`...; matching is whole-word and case-insensitive. A known host also covers the labels after it, and a known domain covers every host inside it, so `dc01.meeza.local` becomes one alias. Any other IP address in the text and the host part of any `scheme://` address is aliased as it appears. Loopback addresses (`127.0.0.1`, `::1`, `0.0.0.0`), `localhost` and the names of the Compose services (`db`, `api`, `web`, `collector`, `simulator`) are left as they are: they say nothing about your site, and the service names tell the reader which container failed. A common word as the user or computer name (`admin`, `SCADA`) is also replaced inside ordinary words and log keys such as `admin.api`, so the report stays readable but looks a little odd. A name glued to a masked name with `-` (`meeza-fs01`) is not recognised. The masking runs after the secrets are scrubbed and before the checksum, so a masked file still verifies.

The legend that says which alias is which original (`MASK LEGEND (screen only; do not paste)`) is printed on the screen after the `saved:` lines and is never written to a file or counted in the checksum. Paste the saved FILE, keep the legend to read the answer. What the script cannot know is not masked: a host name inside a log line that is not a URL, not an address and not one of the names above. Read the file before you paste it. `-ScrubFile <file> -Mask` masks any text file you want to check before pasting; there the screen is the output, so no legend is printed (stderr says so). The shell script has no `--mask`: it refuses the option and points to the PowerShell script.

**Scrubbing.** Every line of both files is scrubbed before it is written: the user name and password inside a URL (`opc.tcp://user:password@host`) become `[hidden]`, and so does every secret value in the project's `.env` (the keys whose name contains PASSWORD, SECRET, TOKEN or KEY; the report says only HOW MANY values it hides, never which). What the scripts cannot know: a source's password is stored encrypted in the database, so a log line that quotes it without a URL around it is not caught. The scrubbers (Python in the application, PowerShell, awk) follow one shared list of cases, `backend/tests/fixtures/scrub_cases.tsv`; `-ScrubFile <file>` (PowerShell) and `--scrub-stdin` (shell) run the same rules over any text file, so you can check or clean a text before pasting it. On Linux the saved files are readable by their owner only. Without `-Mask` the reports do contain addresses of your OT network and the workstation's user and computer name: delete what must not leave.

## Message template to Claude
```
What I did:        (for example: added source "Main SCADA", pressed Check connection)
What I expected:   (all steps OK, values arriving)
What happened:     (step "Secure channel and session" failed, source stays offline)
Report attached:   (paste the report; summary first)
```

## How a fix comes back
1. **A value to type into the UI.** The answer names the exact field (for example Sources > Main SCADA > Security policy = `basic256sha256`, or the endpoint URL).
2. **A small script or SQL file** carried over RDP and run by name (Claude says the file name and the single command).
3. **A rebuilt offline bundle** for a code change: a separate future wave; until then code changes need a connected machine.
