import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type SummaryCardProps = {
  balance?: number;
  trend?: string;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export default function SummaryCard({
  balance = 1234.56,
  trend = "+2.5% from last month",
}: SummaryCardProps) {
  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Total Balance
        </CardTitle>
      </CardHeader>

      <CardContent>
        <div className="text-3xl font-bold tracking-tight">
          {currencyFormatter.format(balance)}
        </div>
        <p className="mt-2 text-sm text-green-600">{trend}</p>
      </CardContent>
    </Card>
  );
}