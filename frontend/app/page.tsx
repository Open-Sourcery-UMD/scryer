import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function Dashboard() {
  const stats = [
    { label: "Total Balance", value: "$12,450.00", trend: "+2.5%" },
    { label: "Monthly Spend", value: "$2,100.40", trend: "-10.2%" },
    { label: "Savings Rate", value: "32%", trend: "+4%" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Welcome back to your financial command center.</p>
      </div>

      {/* Summary Grid */}
      <div className="flex flex-col md:flex-row gap-4 w-full">
        {stats.map((stat) => (
          <div 
            key={stat.label} 
            className="flex-1 rounded-xl border bg-card p-6 shadow-sm flex flex-col justify-between min-h-[160px]"
          >
            <p className="text-sm font-medium text-muted-foreground mb-4">
              {stat.label}
            </p>
            
            <div className="flex flex-wrap items-baseline justify-between gap-2 mt-auto">
              <h2 className="text-3xl font-bold tracking-tight shrink-0">
                {stat.value}
              </h2>
              <span className={cn(
                "text-sm font-semibold px-2 py-1 rounded-md bg-secondary whitespace-nowrap",
                stat.trend.startsWith('+') ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
              )}>
                {stat.trend}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Placeholder for future charts/table */}
      <div className="h-[300px] rounded-xl border border-dashed flex items-center justify-center text-muted-foreground">
        Transaction feed placeholder...
      </div>
    </div>
  );
}