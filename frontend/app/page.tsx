import { Button } from "@/components/ui/button"

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold">
          Hello World 🚀
        </h1>

        <Button variant="default">
          Click Me
        </Button>
      </div>
    </main>
  )
}