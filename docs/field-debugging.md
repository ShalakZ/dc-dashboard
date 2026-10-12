# Field debugging: connecting the dashboard to the real SCADA

The real SCADA is reached from a Windows workstation over RDP. That machine has no internet and nobody can supervise it live, so every failure has to be diagnosable from text you copy out of it and paste into a Claude session, and every fix has to come back as something small you can apply by hand. This page is the protocol.

## The loop
1. Something does not work (a source stays offline, readings are stale, a check fails).
2. You build a **report** on the Diagnostics page (or, if the web app is down, run the offline script) and paste it into a Claude session with the message template below.
3. Claude reads the header, finds the first failing step and answers with one of three kinds of fix (see "How a fix comes back").
4. You apply it, build a new report and paste that too.

The report is the only thing that has to travel. It is plain text, it carries the build id of the code that produced it, and it can be checked for truncation.

## First connection day: checklist
Ask these before the first real connection; write the answers next to the source in the dashboard's notes or in your own file.
- **Endpoint.** The exact URL and port as seen from the workstation (for example `opc.tcp://host:4840/path`). Is it the OPC UA server itself or a gateway / aggregator in front of it? Cluster-internal host names often do not resolve from Docker on Windows: ask for an address the workstation can reach.
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

Every part starts with `DCDASH-REPORT v1 | PART i OF n | build <id> | <time>` and ends with a footer `--- PART i OF n | chars=N lines=N ---`; the last part ends with `END OF REPORT <checksum>`. If the footer or the checksum line is missing in what Claude received, the paste was cut: paste again.

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

## Reading a report (what Claude looks at)
1. The **header**: build id and time, to know which code produced it.
2. The **LATEST CHECK** line right after it: the failing step and the OPC UA status, or "all steps OK", or "no connection check has been run".
3. **ENVIRONMENT**: versions and the clock lines. **SOURCES** and **SOURCE HEALTH**: status, last error, reads per minute and error rate. **POINTS**: the worst points. **JOURNAL**: what changed and when (source went offline / came back, bad points, jobs, clock skew). **API ERRORS**, **AUDIT TAIL**, **STORAGE AND RETENTION**, **SCANS**.

## What never to paste
- Screenshots or text that show a password, a token, the `.env` file, or the contents of `certs/` (private keys).
- Anything from the report is already scrubbed (passwords, secret key, session tokens and password hashes are never in it), but the report **does** contain the addresses of an OT network unless you tick the mask option. You decide what leaves the workstation.

## When the web app is down
The offline script needs no application, no internet and no Docker:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 scada-host:4840 10.0.0.5:502

It prints and saves `dcdash-diag-<time>.txt` (host facts, disk, clock, network adapters, DNS and a TCP connect with milliseconds for each `host:port` you give it, what listens locally, which of docker / wsl / python exist). Its last line `END OF DIAGNOSTICS <checksum>` shows a truncated paste. Copy the text out of the RDP session, or carry the file over RDP drive redirection.

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
