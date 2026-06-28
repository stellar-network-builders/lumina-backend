# Contributing to Vesting Vault

Thank you for your interest in contributing to Vesting Vault! This guide will help you get the development environment set up and running quickly.

## Reporting security vulnerabilities

**Do not open a public issue or PR for a security vulnerability in our own code.**
Report it privately via the repository's **Security → "Report a vulnerability"**
tab. The full disclosure playbook (acknowledgement and remediation timelines,
severity targets, escalation path) is in [`SECURITY.md`](SECURITY.md).

For **dependency** vulnerabilities — how the npm and Cargo trees are scanned
(Dependabot, Snyk, `npm audit`, `cargo audit`), how SBOMs are produced, and the
exemption/escalation policy — see
[`docs/dependency-management.md`](docs/dependency-management.md). A normal PR
referencing the advisory is fine for vulnerable third-party packages.

## Prerequisites

Before you begin, ensure you have the following installed:

- [Docker](https://docs.docker.com/get-docker/) (v20.10 or later)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0 or later)
- [Git](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)

## Quick Start (Recommended)

The fastest way to get started is using Docker Compose:

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Vesting-Vault
   ```

2. **Start all services**
   ```bash
   docker-compose up -d
   ```

3. **Verify services are running**
   ```bash
   # Check backend health
   curl http://localhost:3000/health
   
   # Check all services status
   docker-compose ps
   ```

That's it! Your development environment is now running with:
- Backend API: http://localhost:3000
- PostgreSQL Database: localhost:5432
- Redis Cache: localhost:6379

## Development Workflow

### Running Services

```bash
# Start all services in detached mode
docker-compose up -d

# Start services with logs
docker-compose up

# Stop all services
docker-compose down

# Stop services and remove volumes (clean slate)
docker-compose down -v
```

### Viewing Logs

```bash
# View all logs
docker-compose logs

# View specific service logs
docker-compose logs backend
docker-compose logs db
docker-compose logs redis

# Follow logs in real-time
docker-compose logs -f backend
```

### Backend Development

The backend service is configured for development with hot-reloading:

```bash
# Access the backend container
docker-compose exec backend sh

# Install new dependencies
docker-compose exec backend npm install <package-name>

# Run tests
docker-compose exec backend npm test

# Access database directly
docker-compose exec db psql -U postgres -d vesting_vault
```

### Database Management

```bash
# Connect to PostgreSQL
docker-compose exec db psql -U postgres -d vesting_vault

# Create database migrations (if using Sequelize)
docker-compose exec backend npx sequelize-cli migration:create --name migration_name

# Run migrations
docker-compose exec backend npx sequelize-cli db:migrate
```

## Environment Configuration

### Backend Environment Variables

Copy the example environment file and customize as needed:

```bash
cp backend/.env.example backend/.env
```

Key environment variables:
- `PORT`: Backend server port (default: 3000)
- `NODE_ENV`: Environment (development/production)
- `DB_HOST`: Database host (default: db for Docker)
- `DB_PORT`: Database port (default: 5432)
- `DB_NAME`: Database name (default: vesting_vault)
- `DB_USER`: Database user (default: postgres)
- `DB_PASSWORD`: Database password (default: password)
- `STELLAR_RPC_URL`: Stellar RPC endpoint (e.g., https://soroban-testnet.stellar.org)
- `STELLAR_NETWORK_PASSPHRASE`: Passphrase for the configured network

## Project Structure

```
Vesting-Vault/
├── backend/                 # Node.js backend application
│   ├── src/
│   │   ├── index.js        # Application entry point
│   │   └── database/        # Database configuration
│   ├── Dockerfile          # Backend Docker configuration
│   ├── package.json        # Node.js dependencies
│   └── .env.example        # Environment variables template
├── docker-compose.yml      # Docker services configuration
└── CONTRIBUTING.md         # This file
```

## Common Issues & Solutions

### Port Conflicts

If you encounter port conflicts, modify the port mappings in `docker-compose.yml`:

```yaml
ports:
  - "3001:3000"  # Change host port from 3000 to 3001
```

### Database Connection Issues

1. Ensure the database service is healthy:
   ```bash
   docker-compose ps
   ```

2. Check database logs:
   ```bash
   docker-compose logs db
   ```

3. Verify environment variables in your `.env` file match the database configuration.

### Permission Issues (Linux/Mac)

If you encounter permission errors, run:

```bash
sudo chown -R $USER:$USER .
```

## Development Tips

1. **Use meaningful commit messages** following conventional commit format
2. **Run tests before committing** changes
3. **Check logs** when services don't start properly
4. **Use `docker-compose down -v`** for a completely fresh start
5. **Monitor resource usage** with `docker stats`

## API Endpoints

Once the backend is running, you can access:

- `GET /` - Welcome message
- `GET /health` - Health check endpoint

## Getting Help

If you encounter issues:

1. Check the troubleshooting section above
2. Review service logs: `docker-compose logs`
3. Ensure Docker and Docker Compose are up to date
4. Check that ports 3000, 5432, and 6379 are available

## Code Style Guidelines

- Use ESLint for JavaScript code formatting
- Follow conventional commit message format
- Write meaningful variable and function names
- Add comments for complex logic

Thank you for contributing to Vesting Vault! 🚀
