# Developing

```bash
cd backend
uv sync
uv run pytest
```

Tests start their own TimescaleDB container, so Docker must be running.

Frontend (needs the stack running for the API):

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, /api proxied to localhost:8000
npm test
npm run typecheck
npm run build      # typecheck + production bundle; the grid and the chart widgets are separate, lazily loaded chunks
npm run e2e        # Playwright; needs a fresh stack and an isolated Compose project, see "End-to-end test"
```

For `npm run dev` to reach the API without Caddy, temporarily publish it:
`docker compose run --rm -p 8000:8000 api` or add `ports: ["8000:8000"]` to a
`compose.override.yaml` (ignored by git).

## Brand assets

The logo and the browser-tab icon are the owner's gold M. His original is `docs/brand/logo-original.svg`; `frontend/public/` holds what the app
serves (`logo-mark.svg` for the top bar and the sign-in page, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`).
Run `make-brand-assets.mjs` (in the `frontend/scripts` folder) with `node` from `frontend/` to make them from the original: the SVGs copy its
paths (nothing is redrawn) and Chromium, the one Playwright installs (or the executable in `CHROMIUM_PATH`), draws the PNGs and the ICO. The app
names the logo in one place, `BRAND_MARK_SRC` in `frontend/src/components/BrandMark.tsx`.
