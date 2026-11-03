import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse
import psycopg

APP_VERSION = "0.1.0"

app = FastAPI(title="Scryer API", version=APP_VERSION)

@app.get("/")
def health_check():
    return {"message": "Scryer API is running"}


@app.get("/health")
def health():
    return {"status": "active", "version": APP_VERSION}


@app.get("/ready")
def readiness() -> JSONResponse:
    """Probe the configured database without returning its DSN or exception details."""
    database_url = os.environ.get("DATABASE_URL")
    ready = False
    if database_url:
        try:
            with psycopg.connect(database_url, connect_timeout=2,
                                 options="-c statement_timeout=2000") as connection:
                ready = connection.execute("SELECT 1").fetchone() == (1,)
        except psycopg.Error:
            ready = False
    return JSONResponse(
        {"status": "ready" if ready else "not_ready", "version": APP_VERSION},
        status_code=200 if ready else 503,
    )
