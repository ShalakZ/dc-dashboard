"""What each API route asks of the caller, by route key ("GET /api/health": method, then the path as the router spells it).

PUBLIC: no sign-in. SIGNED_IN: any signed-in account, whatever its role. Every other route names a permission
(ROUTE_PERMISSIONS arrives with the enforcement). The reason is the dict's value so a reader sees why it is listed.
"""

# Routes that answer without a session.
PUBLIC: dict[str, str] = {
    "GET /api/health": "the container health check; it says only whether the database answers",
    "POST /api/login": "it is how a session starts",
    "POST /api/logout": "it ends the caller's own session; with none it is a no-op",
    "GET /api/setup": "tells the sign-in screen whether the first account still has to be created",
    "POST /api/setup": "creates the first account, once; refused (409) as soon as any account exists",
}

# Routes any signed-in account may call.
SIGNED_IN: dict[str, str] = {
    "GET /api/me": "the caller's own account",
    "POST /api/me/password": "changing your own password (it asks for the current one)",
    "PUT /api/me/preferences": "your own display settings (mode and theme)",
    "GET /api/site": "the site name every page header shows",
    "GET /api/version": "the build id every account may see in the profile menu",
    "GET /api/status": "the collector-alive chip in the shell",
}
