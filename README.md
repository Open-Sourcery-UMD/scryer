# Scryer

## Status: Under Construction (Pre-Alpha)

**Scryer is currently under active development.** Features are shifting, bugs are plentiful, and we're still laying the foundational bricks. If you're here early, welcome!

## Open-Source Wealth Intelligence

Scryer is a privacy-first, developer-friendly financial aggregator built by the Open Sourcery Club at UMD for everyone. We believe that you shouldn't have to sell your soul (or your privacy) to keep track of your finances.

## The Vision

Most budgeting tools are "black boxes." *Scryer* is build on the principle of **Financial Sovereignty**:  

- **Local-First**: Your sensitive bank data stays in your Docker container, not our cloud.
- **Extensible**: Anyone can write a parser for their specific bank or local credit union.
- **Automated**: Use Python-driven logic to categorize expenses without the manual headache.

## Tech Stack

We use a modern, decoupled stack designed for high performance and easy contribution:

- **Frontend**: Next.js 14 + Tailwind CSS + Shadcn/UI
- **Backend**: FastAPI (Python 3.12+)
- **Database**: PostgreSQL with Prisma ORM
- **Infrastructure**: Docker & Docker Compose

## Getting Started (The 2-Minute Setup)

You don't need to install 10 different compilers. Just ensure you have **Docker** and **Node.js** installed.

1. **Clone the repo**:

```bash
git clone https://github.com/Open-Sourcery-UMD/scryer.git 
cd scryer
```

2. **Launch the environment**:

```bash
docker-compose up --build
```

3. **Access the Magic**:

- Frontend: <http://localhost:3000>
- API Docs: <http://localhost:8000/docs>

## Contributing

We love contributors! Whether you're a CSS Wizard or a Backend Warlock, there's a spot for you.  

**To contribute**:

1. Fork the repo.
2. Create a branch (feature/cool-new-thing).
3. Open a Pull Request.
