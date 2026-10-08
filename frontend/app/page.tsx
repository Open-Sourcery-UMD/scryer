import SummaryCard from "@/components/SummaryCard";
import TransactionTable from "@/components/TransactionTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Dashboard() {
  const statCards = [
    {
      title: "Monthly Spend",
      value: "$2,100.40",
      trend: "-10.2% vs. last month",
      trendClassName: "text-green-700 dark:text-green-400",
    },
    {
      title: "Savings Rate",
      value: "32%",
      trend: "+4.0% vs. last month",
      trendClassName: "text-green-700 dark:text-green-400",
    },
    {
      title: "Upcoming Bills",
      value: "$640.00",
      trend: "Due in 6 days",
      trendClassName: "text-muted-foreground",
    },
  ];

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back to your financial command center.
        </p>
      </div>

      <SummaryCard
        title="Net Worth"
        value={12450.56}
        trend="+2.5% from last month"
      />

      <div className="grid gap-4 md:grid-cols-3">
        {statCards.map((statCard) => (
          <Card key={statCard.title} className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {statCard.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-2xl font-semibold tracking-tight">
                {statCard.value}
              </div>
              <p className={`text-sm ${statCard.trendClassName}`}>
                {statCard.trend}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Recent Transactions
          </h2>
          <p className="text-sm text-muted-foreground">
            A quick look at the latest activity across your accounts.
          </p>
        </div>
        <TransactionTable />
      </section>
    </div>
  );
}
