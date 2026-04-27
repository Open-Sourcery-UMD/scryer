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

export default function TransactionTable() {
  return (
    <div className="overflow-x-auto">
      <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
        <table className="w-full border-collapse">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-muted-foreground">
                Date
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-muted-foreground">
                Merchant
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-muted-foreground">
                Category
              </th>
              <th className="px-4 py-3 text-right text-sm font-semibold text-muted-foreground">
                Amount
              </th>
            </tr>
          </thead>

          <tbody>
            {transactions.map((transaction, index) => (
              <tr
                key={index}
                className="border-t border-border transition-colors hover:bg-accent"
              >
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {transaction.date}
                </td>
                <td className="px-4 py-3 text-sm text-foreground">
                  {transaction.merchant}
                </td>
                <td className="px-4 py-3 text-sm">
                  <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                    {transaction.category}
                  </span>
                </td>
                <td
                  className={[
                    "px-4 py-3 text-right text-sm font-semibold",
                    transaction.amount < 0
                      ? "text-red-700 dark:text-red-400"
                      : "text-green-700 dark:text-green-400",
                  ].join(" ")}
                >
                  {currencyFormatter.format(transaction.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
