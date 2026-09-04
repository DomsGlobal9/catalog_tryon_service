# ScaleEasy Catalog Try-On Microservice

This microservice handles the AI-powered Virtual Try-On catalog generation for the ScaleEasy platform. It includes an Express.js backend (with Prisma & PostgreSQL) and a Vite/React frontend.

## 🚀 Getting Started for Local Development

If you are a new developer cloning this repository, follow these steps to get the environment running locally.

### 1. Prerequisites
- **Node.js** (v18 or higher)
- **Docker** and **Docker Compose** (if running via Docker)
- **PostgreSQL** (if running locally without Docker)

### 2. Environment Setup
You need to set up Environment Variables for both the **Backend** and the **Frontend**.

#### Backend `.env`
Create a `.env` file in the root directory (`/`) and add the following keys:
```env
# Database connection for Prisma
DATABASE_URL="postgresql://user:password@host:port/database"

# Gemini AI API Key for Image Generation
GEMINI_API_KEY="your_gemini_api_key_here"

# Internal key the Super Admin Gateway must send as x-api-key.
# Required — the service refuses to boot without it.
SERVICE_API_KEY="se_catalog_internal_key_v1_..."

# Server Port
PORT=4005

# ── Reliability / capacity (all optional, sensible defaults shown) ───────────
GEMINI_TIMEOUT_MS=120000          # wall-clock ceiling for one Gemini call
MAX_CONCURRENT_GENERATIONS=3      # excess requests get 429, not a queue
SSE_HEARTBEAT_MS=15000            # keepalive during the gaps between views
SHUTDOWN_GRACE_MS=30000           # forced exit if in-flight work will not drain
DB_POOL_MAX=10
DB_POOL_IDLE_MS=30000
DB_POOL_CONNECT_MS=10000

# ── Generation speed ────────────────────────────────────────────────────────
BASE_MODEL_CACHE_MAX=24           # processed base poses cached in memory
PARALLEL_VIEWS=true               # set false to generate the 3 dependent views serially
INPUT_IMAGE_FORMAT=jpeg           # png restores the original (much larger) uploads
INPUT_IMAGE_QUALITY=95

# ── Design Discovery (optional) ──────────────────────────────────────────────
# Leave SERPER_API_KEY empty to run without design discovery: the service still
# boots and catalog generation works normally, while /api/v1/discovery/* returns
# 424. Everything below has a sensible default and can be omitted.
# VENDOR NOTE: this is a serper.dev key, NOT serpapi.com. Two different
# companies, similar names. Only serper.dev works here; a serpapi.com key is
# rejected with 403. Key shapes seen in the wild: serper.dev = 40 hex chars,
# serpapi.com = 64 hex chars. The service warns at boot if it spots the latter.
SERPER_API_KEY=""                  # get one at https://serper.dev/api-key
SERPER_COUNTRY="in"                # Google country bias; 'in' suits ethnic wear
SERPER_LANGUAGE="en"
SERPER_TIMEOUT_MS=8000
DISCOVERY_CACHE_TTL_SEC=3600       # repeat searches served from cache, not re-billed
DISCOVERY_CACHE_MAX_ENTRIES=500
DISCOVERY_RATE_LIMIT_PER_MIN=20    # searches per minute, per clientId
```

#### Frontend `.env`
Create a `.env` file in the `/frontend` directory and add the following keys to connect to the Super Admin Gateway:
```env
# Production: requests go through the Super Admin gateway.
VITE_API_URL="https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping/generate-catalog"
VITE_API_KEY="sk_live_..." # the gateway/client key

# Development: `npm run dev` talks DIRECTLY to http://localhost:4005, which
# authenticates with the service's own SERVICE_API_KEY - the gateway key above
# is rejected there. Without this the UI loads but every request returns 401.
VITE_DEV_API_KEY="<the same value as SERVICE_API_KEY in the root .env>"

# No key is committed to source; both live only in this gitignored file.
```

---

### 3. Database Initialization
Before running the server, ensure your database schema is pushed and the Prisma client is generated:
```bash
# Install dependencies
npm install

# Push schema to the database (if starting fresh)
npx prisma db push

# Generate Prisma Client
npx prisma generate
```

---

### 4. Running the Application

You can run the application either using Docker (Backend) or natively via Node/npm.

#### Option A: Running via Docker (Backend Only)
Since the backend is fully Dockerized, you can build and run it as an isolated container.

```bash
# Build the Docker image
docker build -t catalog-tryon-service .

# Run the container (Make sure to pass your .env file)
docker run -p 4005:4005 --env-file .env catalog-tryon-service
```
*Note: The frontend is typically run separately during development.*

#### Option B: Running Natively (Backend + Frontend)
If you prefer running it locally for active development:

**Start the Backend:**
```bash
# In the root directory
npm start
# (Server will start on http://localhost:4005)
```

**Start the Frontend:**
```bash
# Open a new terminal
cd frontend
npm install
npm run dev
# (Frontend will start on http://localhost:5173)
```

---

## ✅ Tests

```bash
npm test          # offline: no network, no server, no API credits. Safe for CI.
npm run test:live # additionally drives a running service on :4005
```

The offline suite covers taxonomy integrity, garment canonicalisation, prompt
resolution, the instruction parser, query building, result filtering and the
`fetchable` contract. It also pins two things that were real defects:

- **a dropped download is retried, not fatal** — the response body read must stay
  inside the retry loop in both pipelines
- **no service key may be committed** — the suite fails if one reappears in source

The live suite adds auth, discovery, pipeline routing, and asserts that **no
failure path returns 5xx**, since the gateway's circuit breaker counts those per
slug and would take the whole service down.

---

## 🛠 Architecture & Features
* **Streaming Responses (SSE):** The backend streams AI generation events in real-time to the frontend.
* **Zombie Process Killer:** The backend tracks active jobs per `clientId`. If a user refreshes the page and requests a new generation, the server automatically aborts the old zombie pipeline to save GPU compute.
* **Prisma ORM:** Used for strict schema validation and database interactions.
* **Design Discovery:** A second, independent capability at `/api/v1/discovery/*` that turns keywords
  — or one line of natural language — into web design references via Serper. It is browse-only: it
  never downloads or stores images, and is entirely decoupled from the generation pipeline
  (`src/modules/discovery/` imports nothing from the rest of `src/`).
  * **Taxonomy-driven.** 12 garments and 107 design areas (Saree → Pallu, Border, Zari…) live in
    `src/modules/discovery/taxonomy/` and are the source of truth; the search provider knows none of
    them. `GET /api/v1/discovery/taxonomy` returns the tree for a Manage Designs UI.
  * **Canonical ids match the generation service** (`LEHANGA`, `KURTHI`), with `LEHENGA`/`KURTI`
    accepted as aliases, so one id means one garment platform-wide.
  * **Web plus social sources.** Pinterest, Instagram and Facebook results are all returned. Every
    result carries a `fetchable` block — the URL that can actually be retrieved plus the true
    dimensions of that asset — so a consumer never has to know that Instagram serves HTML at
    `imageUrl`. `width`/`height` still describe the original for provenance. Instagram and Facebook
    designs are only ever available at ~400px.
  * **Fails soft twice over.** With no `SERPER_API_KEY`, or if the taxonomy fails its integrity check,
    the service boots normally, logs the reason, and only the discovery routes return `424`. Catalog
    generation is never affected.

For detailed API documentation, refer to the `API_DOCUMENTATION.md` file.
