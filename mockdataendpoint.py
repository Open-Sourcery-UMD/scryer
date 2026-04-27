from datetime import datetime
from fastapi import FastAPI
from app.schemas.transaction import TransactionCreate

app = FastAPI()


@app.get("/api/v1/mock-transactions", response_model=list[TransactionCreate])
def get_mock_transactions():
    return [
        TransactionCreate(
            description="Chipotle",
            amount=12.99,
            date=datetime(2026, 3, 10, 12, 30),
            category="Fast-Food",
        ),
        TransactionCreate(
            description="Apartment Rent",
            amount=1850.00,
            date=datetime(2026, 3, 1, 9, 0),
            category="Rent",
        ),
        TransactionCreate(
            description="Monthly Paycheck",
            amount=3200.00,
            date=datetime(2026, 3, 5, 8, 0),
            category="Salary",
        ),
        TransactionCreate(
            description="Trader Joe's",
            amount=84.27,
            date=datetime(2026, 3, 8, 17, 45),
            category="Groceries",
        ),
        TransactionCreate(
            description="Shell Gas",
            amount=42.10,
            date=datetime(2026, 3, 9, 18, 15),
            category="Transportation",
        ),
    ]
