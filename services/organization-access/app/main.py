from fastapi import FastAPI

from app.config import SERVICE_NAME

app = FastAPI(title="BOWERA Organization & Access", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": SERVICE_NAME}