"""Plain-language hints for a failed connection-check step: the usual cause, and what to ask the SCADA or network team.

`hint_for(status_name, exc_class, step_id)` is a lookup in two tables, an OPC UA status name first and the exception class second.
A failure that is not an exception (a clock that is off) uses the pseudo status name `CLOCK_SKEW`. Every line fits one report
line (300 characters).
"""

CLOCK_SKEW = "ClockSkew"  # pseudo status name: the server clock is more than 300 s away from ours

_CLOCK_ALSO = " Also check that the clocks of both machines agree."

# Codes a gateway sends when the OPC UA server itself works but the device behind it does not deliver a value.
_DEVICE_FAULT = (
    "The SCADA server answers, but the device behind it reports a fault (or has not delivered a value yet) for these points. Ask "
    "the SCADA team which device or signal this is and whether it is in service."
)
DEVICE_FAULT_CODES = (
    "BadSensorFailure", "BadDeviceFailure", "BadCommunicationError", "BadNoCommunication", "BadOutOfService",
    "BadWaitingForInitialData",
)

_BY_STATUS: dict[str, str] = {
    "BadSecurityChecksFailed": (
        "The server refused the secure channel; usually it does not trust our client certificate. Ask the SCADA team to trust the "
        "thumbprint shown in the certificates step."
    ),
    "BadCertificateUntrusted": (
        "The server does not trust a certificate. Ask the SCADA team to move our client certificate (thumbprint in the certificates "
        "step) to the server's trusted list; if we reject theirs, its certificate must be added to our trust list."
    ),
    "BadCertificateInvalid": (
        "A certificate was rejected as unusable (malformed, wrong key usage or a broken chain). Check the expiry in the certificates "
        "step, regenerate ours if needed, or ask the SCADA team to check theirs."
    ),
    "BadCertificateHostNameInvalid": (
        "The server certificate does not name the host we connect to. Connect with the host name or IP the certificate lists, or ask "
        "the SCADA team to reissue it with the right name."
    ),
    "BadCertificateTimeInvalid": (
        "A certificate is expired or not valid yet. Check the dates in the certificates step and renew the one that is out of date. "
        "Also check that the clocks of both machines agree."
    ),
    "BadCertificateUriInvalid": (
        "The server compares two URIs and they differ: the ApplicationUri our client announces and the URI in our client "
        "certificate. We announce the certificate's own URI (certificates step), so a certificate without one cannot match. "
        "Regenerate it with a URI, or ask the SCADA team which they expect."
    ),
    "BadIdentityTokenRejected": (
        "The server rejected the user identity. Ask the SCADA team whether this endpoint wants a user name and password (see the "
        "user-token types in the endpoints step) and check the ones entered here."
    ),
    "BadIdentityTokenInvalid": (
        "The server could not use the identity we sent. Check that the source has a user name and a password, and that the endpoint "
        "offers user name and password (endpoints step)."
    ),
    "BadUserAccessDenied": (
        "The account is not allowed to connect or to read. Ask the SCADA team to check the password and to give this account read "
        "access to the nodes."
    ),
    "BadTcpEndpointUrlInvalid": (
        "The server does not accept this endpoint URL. Use the host name, port and path exactly as the SCADA team gives them, "
        "or a firewall or gateway may be answering instead of the server."
    ),
    "BadNodeIdUnknown": (
        "The node id or its namespace index does not exist on this server. Namespace indexes can change when the server restarts: "
        "compare with the namespaces step and browse the source again."
    ),
    "BadNodeIdInvalid": (
        "The node id is not written in a form the server accepts. Check the address of the point (for example ns=2;s=Name or "
        "ns=2;i=1234)."
    ),
    "BadTimeout": (
        "The server did not answer in time. The network may be slow or a firewall may be dropping packets; ask the network team, and "
        "check whether the server is overloaded."
    ),
    "BadRequestTimeout": (
        "The server did not answer in time. The network may be slow or a firewall may be dropping packets; ask the network team, and "
        "check whether the server is overloaded."
    ),
    "BadNotReadable": (
        "The server does not let this account read the node. Ask the SCADA team to give the account read access to the points "
        "listed, or map a different node."
    ),
    "BadTooManyOperations": (
        "The server refused a read of that many nodes at once. Ask the SCADA team for the server's MaxNodesPerRead limit; "
        "the check already reads in batches of at most 100."
    ),
    "BadSecurityPolicyRejected": (
        "The server does not offer the security policy we asked for. See the endpoints step for what it offers and set the "
        "source's security policy to one of those, or ask the SCADA team which to use."
    ),
    "BadSessionClosed": (
        "The server closed the session. Common causes: a limit on the number of sessions, an idle timeout, or a firewall that "
        "cuts long connections. Ask the SCADA team how many sessions are allowed."
    ),
    "BadSessionIdInvalid": (
        "The server no longer knows the session. It was closed or restarted; ask the SCADA team whether the server restarted."
    ),
    "BadSecureChannelClosed": (
        "The secure channel was closed by the server or by something in between. Ask the SCADA team and the network team "
        "whether a firewall or the server's session limit cut it."
    ),
    "BadConnectionClosed": (
        "The connection was closed by the server or by something in between. Ask the SCADA team and the network team whether a "
        "firewall or the server's session limit cut it."
    ),
    "BadTooManySessions": (
        "The server has reached its session limit. Ask the SCADA team to free sessions or to raise the limit."
    ),
    "BadInvalidTimestamp": (
        "The server rejected a timestamp. The clocks of the two machines differ too much; see the clock lines and fix the one that "
        "is wrong (a Docker Desktop VM clock drifts after the host sleeps)."
    ),
    **dict.fromkeys(DEVICE_FAULT_CODES, _DEVICE_FAULT),
    CLOCK_SKEW: (
        "The clocks differ by over 5 minutes, which OPC UA does not tolerate. Local cause first: the Docker Desktop VM clock drifts "
        "after the host sleeps (restart Docker Desktop). If the report's browser-vs-container difference is also large, it is local; "
        "if not, ask the SCADA team about their time source."
    ),
}

# The session step with one of these also depends on the clock, so a clock sentence is added.
_CLOCK_RELATED_AT_SESSION = {"BadSecurityChecksFailed", "BadCertificateTimeInvalid", "BadInvalidTimestamp"}

_BY_CLASS: dict[str, str] = {
    "gaierror": (
        "The host name could not be resolved. Check the spelling, try the IP address instead, and ask the network team whether this "
        "name resolves from this machine (inside Docker the DNS can differ from the Windows host)."
    ),
    "ConnectionRefusedError": (
        "The host answered but nothing listens on that port. The port is wrong, the OPC UA service is stopped, or a firewall "
        "rejects the connection. Ask the SCADA team for the exact endpoint URL and port."
    ),
    "ConnectionResetError": (
        "The connection was reset by the other end or by something in between. Ask the SCADA team whether the service accepts "
        "this client, and the network team about a firewall or load balancer."
    ),
    "UnusableAnswerError": (  # opcua.UnusableAnswerError: this client hung up on an answer it could not read
        "The server's answer was not usable OPC UA: check that the port is the OPC UA port, and that nothing like a TLS proxy or "
        "another protocol listens there. Ask the SCADA team for the exact endpoint URL and port, and the network team whether a "
        "proxy sits in between."
    ),
    "ConnectionAbortedError": (
        "The connection was cut during the exchange. Ask the SCADA team and the network team whether a firewall or the server's "
        "session limit closed it."
    ),
    "BrokenPipeError": (
        "The connection was cut during the exchange. Ask the SCADA team and the network team whether a firewall or the server's "
        "session limit closed it."
    ),
}

# A second hint for BadNodeIdUnknown, used only when the bad addresses carry the number AVEVA Plant SCADA's browse puts in front of a
# tag and the source's option "Stable tag addresses" is off (w34 R8). The generic hint above stays as it is. The sentence says what
# it rests on: a community answer, not documentation, and not tested against the owner's SCADA.
NUMBERING_CHANGED = (
    "The SCADA's tag numbering may have changed (a number in front of the tag from browsing; a community answer says it can, not "
    'tested against your SCADA). Try "Stable tag addresses" on this source, then Test.'
)

# The suggestion (w34 R6) that Test, the connection check's read_points hint and the report's SOURCE HEALTH line all make, in these
# words, for an OPC UA source that looks like AVEVA Plant SCADA while its option "Stable tag addresses" is off. It is a guess from a
# community answer and says so.
SUGGEST_STABLE = (
    "This server looks like AVEVA Plant SCADA and its tag addresses carry a number that can change (a community answer says so, "
    'not tested against your SCADA). Consider "Stable tag addresses" (Edit source).'
)

_TIMEOUT_AT_NETWORK_STEP = (
    "No answer from that address and port: a firewall is probably dropping the traffic, the address or port is wrong, or the host "
    "is down. Ask the network team whether this machine may reach it, and confirm the endpoint URL with the SCADA team."
)
_TIMEOUT_LATER = (
    "The server accepted the connection but did not answer in time: it may be overloaded or a firewall may be dropping packets. "
    "Ask the SCADA team and the network team."
)
_TIMEOUT_HANDSHAKE = (  # the steps that open the session: it needs several requests under one timeout
    "The server accepted the connection but did not answer in time: it may be overloaded or a firewall may be dropping packets. "
    "A session needs about four round trips, so answers of about a quarter of the timeout can still time out. Ask the SCADA team "
    "and the network team."
)
_NETWORK_UNREACHABLE = (
    "There is no network route to that address. Check the address and ask the network team whether this machine may reach it."
)


def hint_for(status_name: str | None, exc_class: str | None, step_id: str) -> str | None:
    """The hint for a failure, or None when there is nothing useful to add.

    `status_name` is an OPC UA status name ("BadUserAccessDenied") or `CLOCK_SKEW`; `exc_class` the class name of the root
    exception ("gaierror", "TimeoutError"); `step_id` the step that failed (a timeout means something different at "tcp").
    """
    if status_name:
        text = _BY_STATUS.get(status_name)
        if text is not None:
            if step_id == "session" and status_name in _CLOCK_RELATED_AT_SESSION and "clock" not in text:
                return text + _CLOCK_ALSO
            return text
    if exc_class:
        text = _BY_CLASS.get(exc_class)
        if text is not None:
            return text
        if exc_class == "TimeoutError":
            if step_id in ("dns", "tcp"):
                return _TIMEOUT_AT_NETWORK_STEP
            return _TIMEOUT_HANDSHAKE if step_id in ("endpoints", "session") else _TIMEOUT_LATER
        if exc_class == "OSError":
            return _NETWORK_UNREACHABLE
    return None
