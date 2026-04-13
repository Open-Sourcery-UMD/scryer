# Use a slim version of Python to keep the image small
FROM python:3.11-slim as base

# Set environment variables
# Prevent Python from writing .pyc files and keep stdout unbuffered for Docker logs
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV APP_HOME /app

WORKDIR $APP_HOME

# Install system dependencies (needed for some Python packages like psycopg2 or cryptography)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
# We copy only requirements first to leverage Docker's cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend code
COPY . .

# Expose the port FastAPI will run on
EXPOSE 8000

# Run the application using uvicorn
# Using --host 0.0.0.0 is critical for Docker networking
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]