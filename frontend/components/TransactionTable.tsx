import React from "react";

type Transaction = {
  date: string;
  merchant: string;
  category: string;
  amount: number;
};

const transactions: Transaction[] = [
  {
    date: "2026-04-01",
    merchant: "Whole Foods",
    category: "Groceries",
    amount: -82.47,
  },
  {
    date: "2026-04-02",
    merchant: "Payroll Deposit",
    category: "Income",
    amount: 2450.0,
  },
  {
    date: "2026-04-02",
    merchant: "Metro Transit",
    category: "Transportation",
    amount: -15.0,
  },
  {
    date: "2026-04-03",
    merchant: "Netflix",
    category: "Subscriptions",
    amount: -18.99,
  },
  {
    date: "2026-04-03",
    merchant: "Freelance Client",
    category: "Income",
    amount: 620.0,
  },
];

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatAmount(amount: number) {
  const formatted = currencyFormatter.format(Math.abs(amount));
  return amount < 0 ? `-${formatted}` : formatted;
}

export default function TransactionTable() {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "Arial, sans-serif",
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <thead>
          <tr style={{ backgroundColor: "#f9fafb" }}>
            <th style={headerCellStyle}>Date</th>
            <th style={headerCellStyle}>Merchant</th>
            <th style={headerCellStyle}>Category</th>
            <th style={{ ...headerCellStyle, textAlign: "right" }}>Amount</th>
          </tr>
        </thead>

        <tbody>
          {transactions.map((transaction) => (
            <tr key={`${transaction.date}-${transaction.merchant}-${transaction.amount}`}>
              <td style={bodyCellStyle}>{transaction.date}</td>
              <td style={bodyCellStyle}>{transaction.merchant}</td>
              <td style={bodyCellStyle}>{transaction.category}</td>
              <td
                style={{
                  ...bodyCellStyle,
                  textAlign: "right",
                  fontWeight: 600,
                  color: transaction.amount < 0 ? "#dc2626" : "#16a34a",
                }}
              >
                {formatAmount(transaction.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const headerCellStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e5e7eb",
  textAlign: "left",
  fontSize: "14px",
  fontWeight: 600,
  color: "#374151",
};

const bodyCellStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e5e7eb",
  fontSize: "14px",
  color: "#111827",
};