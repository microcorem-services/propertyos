# Microcorem PropertyOS

A public portfolio demonstration of a property asset management application.

**Current status:** Phase 1 starter. The Next.js dashboard displays fictional, hard-coded property records. The FastAPI backend exposes only a health endpoint. **There is no database, authentication, CRUD, or production deployment yet.**

## Technology
- Next.js App Router, React, TypeScript
- Python / FastAPI (separate backend starter)
- GitHub Actions checks

## Run locally
Requires Node.js 22+ and Python 3.12+.

```bash
npm install
npm run dev
```
Open http://localhost:3000.

For the backend, in a separate terminal:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```
Open http://localhost:8000/health.

## Next milestones
1. Add PostgreSQL and migration tooling.
2. Build property CRUD endpoints and connect the dashboard.
3. Add authentication and role-based access controls.
4. Add tests for real user workflows.
5. Deploy to a separate AWS development environment.

## Security and publication
Only fictional demonstration records are included. Never commit `.env`, AWS keys, tenant information, or private corporate assets. Review commit history and files before making the repository public.

## AI-assisted development
This project uses AI-assisted development. Implementation, tests, and security decisions should be reviewed and validated by the project maintainer before production use.
