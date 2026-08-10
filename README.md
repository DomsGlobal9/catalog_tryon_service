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

# Server Port
PORT=4005
```

#### Frontend `.env`
Create a `.env` file in the `/frontend` directory and add the following keys to connect to the Super Admin Gateway:
```env
VITE_API_URL="https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping/generate-catalog"
VITE_API_KEY="sk_live_..." # (Ask the team lead for the Super Admin API Key)
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

## 🛠 Architecture & Features
* **Streaming Responses (SSE):** The backend streams AI generation events in real-time to the frontend.
* **Zombie Process Killer:** The backend tracks active jobs per `clientId`. If a user refreshes the page and requests a new generation, the server automatically aborts the old zombie pipeline to save GPU compute.
* **Prisma ORM:** Used for strict schema validation and database interactions.

For detailed API documentation, refer to the `API_DOCUMENTATION.md` file.
