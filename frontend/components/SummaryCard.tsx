import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type SummaryCardProps = {
  title?: string
  value?: number
  trend?: string
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function getTrendClasses(trend: string) {
  if (trend.trim().startsWith("+")) {
    return "bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-400"
  }

  if (trend.trim().startsWith("-")) {
    return "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400"
  }

  return "bg-secondary text-secondary-foreground"
}

export default function SummaryCard({
  title = "Net Worth",
  value = 1234.56,
  trend = "+2.5% from last month",
}: SummaryCardProps) {
  return (
    <Card className="border-primary/10 bg-card shadow-sm">
      <CardHeader className="space-y-2 pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-4xl font-bold tracking-tight sm:text-5xl">
          {currencyFormatter.format(value)}
        </div>
        <div
          className={[
            "inline-flex items-center rounded-full px-3 py-1 text-sm font-medium",
            getTrendClasses(trend),
          ].join(" ")}
        >
          {trend}
        </div>
      </CardContent>
    </Card>
  )
}
