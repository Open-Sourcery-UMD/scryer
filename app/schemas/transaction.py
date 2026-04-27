from datetime import datetime
from typing import Optional
from pydantic import BaseModel

class TransactionBase(BaseModel):
    description: str
    amount: float
    date: datetime
    category: Optional[str] = None


class TransactionCreate(TransactionBase):
    pass