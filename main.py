from fastapi import FastAPI

app = FastAPI(title="Scryer API")

@app.get("/")
def health_check():
    return {"message": "Scryer API is running"}