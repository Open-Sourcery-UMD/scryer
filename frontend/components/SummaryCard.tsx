import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type SummaryCardProps = {
  title?: string;
  value?: number;
  trend?: string;
  format?: "currency" | "percent" | "number";
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatValue(value: number, format: SummaryCardProps["format"]) {
  switch (format) {
    case "percent":
      return percentFormatter.format(value);
    case "number":
      return numberFormatter.format(value);
    case "currency":
    default:
      return currencyFormatter.format(value);
  }
}

function getTrendBadgeClasses(title: string, trend: string) {
  const trimmedTrend = trend.trim();
  const isPositive = trimmedTrend.startsWith("+");
  const isNegative = trimmedTrend.startsWith("-");
  const isSpendOrDebt = /spend|debt/i.test(title);

  if (!isPositive && !isNegative) {
    return "bg-muted text-muted-foreground";
  }

  if (isSpendOrDebt) {
    return isPositive
      ? "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400"
      : "bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-400";
  }

  return isPositive
    ? "bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-400"
    : "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400";
}

export default function SummaryCard({
  title = "Total Balance",
  value = 1234.56,
  trend = "+2.5% from last month",
  format = "currency",
}: SummaryCardProps) {
  const trendClasses = getTrendBadgeClasses(title, trend);

  return (
    <Card className="h-full w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>

      <CardContent>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <div className="text-3xl font-bold tracking-tight">
            {formatValue(value, format)}
          </div>

          <span
            className={[
              "inline-flex items-center rounded-full px-2.5 py-1",
              "text-xs font-medium",
              trendClasses,
            ].join(" ")}
          >
            {trend}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}