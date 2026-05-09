from fastapi import FastAPI

APP_VERSION = "0.1.0"

app = FastAPI(title="Scryer API", version=APP_VERSION)

@app.get("/")
def health_check():
    return {"message": "Scryer API is running"}


@app.get("/health")
def health():
    return {"status": "active", "version": APP_VERSION}
