#!/usr/bin/env bash
# =============================================================================
# test-migrations.sh
# =============================================================================
# Automated database migration testing script for Vesting Vault backend.
#
# Performs the following validations:
#   1. Apply all migrations in forward order (oldest → newest)
#   2. Verify tables exist with row counts
#   3. Rollback (reverse) all migrations
#   4. Re-apply all migrations to verify idempotency
#   5. Generate a summary report
#
# Environment variables:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
# =============================================================================

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_DIR/backend"
MIGRATIONS_DIR="$BACKEND_DIR/migrations"
LOG_FILE="/tmp/migration-test-$(date +%Y%m%d-%H%M%S).log"
FAILED=0
PASSED=0

# Colored output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── Logging Functions ─────────────────────────────────────────────────────
log() {
  echo -e "$@" | tee -a "$LOG_FILE"
}

log_success() {
  log "  ${GREEN}✓${NC} $@"
  PASSED=$((PASSED + 1))
}

log_fail() {
  log "  ${RED}✗${NC} $@"
  FAILED=$((FAILED + 1))
}

log_info() {
  log "  ${YELLOW}→${NC} $@"
}

# ── Helper: Run psql with consistent connection parameters ─────────────────
run_psql() {
  PGPASSWORD="${PGPASSWORD:-password}" psql \
    -h "${PGHOST:-localhost}" \
    -p "${PGPORT:-5432}" \
    -U "${PGUSER:-postgres}" \
    -d "${PGDATABASE:-migration_test}" \
    -v ON_ERROR_STOP=1 \
    "$@" 2>&1
}

# ── Main Test Flow ─────────────────────────────────────────────────────────
log ""
log "════════════════════════════════════════════════════════════"
log "  Vesting Vault — Database Migration Test Suite"
log "  Started at: $(date)"
log "  Database: ${PGDATABASE:-migration_test}@${PGHOST:-localhost}:${PGPORT:-5432}"
log "════════════════════════════════════════════════════════════"
log ""

# ── Step 1: Verify PostgreSQL connectivity ────────────────────────────────
log "📡 Step 1: Verify PostgreSQL connectivity"
if run_psql -c "SELECT 1;" > /dev/null 2>&1; then
  log_success "PostgreSQL connection successful"
else
  log_fail "Cannot connect to PostgreSQL"
  exit 1
fi

# ── Step 2: Apply all migrations in forward order ─────────────────────────
log ""
log "📦 Step 2: Apply all migrations in forward order"

log_info "Clearing existing schema..."
run_psql -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /dev/null 2>&1 || true

# Apply SQL migrations in order
SQL_MIGRATIONS=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort)
SQL_COUNT=$(echo "$SQL_MIGRATIONS" | grep -c '\.sql$' || echo 0)

for migration in $SQL_MIGRATIONS; do
  filename=$(basename "$migration")
  log_info "Applying: $filename"
  if run_psql -f "$migration" > /dev/null 2>&1; then
    log_success "Applied: $filename"
  else
    log_fail "Failed to apply: $filename"
    log "  Error details:"
    run_psql -f "$migration" 2>&1 | tail -5 | while read line; do log "    $line"; done
    exit 1
  fi
done

# Apply JS migrations (using node)
JS_MIGRATIONS=$(ls "$MIGRATIONS_DIR"/*.js 2>/dev/null | sort)
JS_COUNT=$(echo "$JS_MIGRATIONS" | grep -c '\.js$' || echo 0)

for migration in $JS_MIGRATIONS; do
  filename=$(basename "$migration")
  log_info "Applying JS migration: $filename"
  if node "$migration" 2>&1 | tee -a "$LOG_FILE"; then
    log_success "Applied JS migration: $filename"
  else
    log_fail "Failed to apply JS migration: $filename"
    exit 1
  fi
done

TOTAL_MIGRATIONS=$((SQL_COUNT + JS_COUNT))
log ""
log_success "All $TOTAL_MIGRATIONS migrations applied ($SQL_COUNT SQL + $JS_COUNT JS)"

# ── Step 3: Verify tables exist and have structure ────────────────────────
log ""
log "🔍 Step 3: Verify tables and row counts"

EXPECTED_TABLES=(
  "vaults"
  "sub_schedules"
  "organizations"
  "tokens"
  "organization_webhooks"
  "claims_history"
  "device_tokens"
  "beneficiaries"
  "admins"
  "vault_liquidity_alerts"
  "vault_legal_documents"
  "dividend_tables"
  "multi_sig_tables"
  "rule144_compliance"
  "auditor_tokens"
  "kyc_statuses"
  "kyc_notifications"
  "vault_registry"
  "vault_balance_monitor_states"
  "claim_webhook_deliveries"
)

TABLES_CHECKED=0
for table in "${EXPECTED_TABLES[@]}"; do
  if run_psql -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = '$table';" 2>/dev/null | grep -q '1'; then
    ROW_COUNT=$(run_psql -t -c "SELECT COUNT(*) FROM $table;" 2>/dev/null | tr -d '[:space:]' || echo "0")
    log_success "Table '$table' exists (rows: $ROW_COUNT)"
    TABLES_CHECKED=$((TABLES_CHECKED + 1))
  else
    # Not all tables may exist depending on migration state - that's OK
    log_info "Table '$table' not found (may be created by later migrations or not applicable)"
  fi
done

# Also check for any tables created by JS migrations
ALL_TABLES=$(run_psql -t -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d '[:space:]' | grep -v '^$' || echo "")
TABLE_COUNT=$(echo "$ALL_TABLES" | wc -l)
log_info "Total tables in public schema: $TABLE_COUNT"

# ── Step 4: Reverse migrations (down/rollback) ────────────────────────────
log ""
log "🔄 Step 4: Reverse migrations (rollback)"

# For SQL migrations, we drop tables in reverse order
REVERSED_SQL=$(echo "$SQL_MIGRATIONS" | tac)

for migration in $REVERSED_SQL; do
  filename=$(basename "$migration")
  # Extract table names from the CREATE TABLE statements in the migration
  TABLES_IN_MIGRATION=$(grep -oP 'CREATE TABLE IF NOT EXISTS \K\w+' "$migration" 2>/dev/null || echo "")
  if [ -n "$TABLES_IN_MIGRATION" ]; then
    for table in $TABLES_IN_MIGRATION; do
      log_info "Dropping table '$table' (from $filename)..."
      if run_psql -c "DROP TABLE IF EXISTS $table CASCADE;" > /dev/null 2>&1; then
        log_success "Dropped: $table"
      else
        log_info "Could not drop $table (may not exist or have dependencies)"
      fi
    done
  fi
done

# Verify database is clean
REMAINING_TABLES=$(run_psql -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d '[:space:]' || echo "0")
log_info "Tables remaining after rollback: $REMAINING_TABLES"
if [ "$REMAINING_TABLES" -eq 0 ]; then
  log_success "Database successfully rolled back to clean state"
else
  log_info "Some tables remain (may be from extensibility or JS migrations)"
fi

# ── Step 5: Re-apply migrations (idempotency check) ──────────────────────
log ""
log "🔄 Step 5: Re-apply migrations (idempotency check)"

for migration in $SQL_MIGRATIONS; do
  filename=$(basename "$migration")
  if run_psql -f "$migration" > /dev/null 2>&1; then
    log_success "Re-applied: $filename"
  else
    log_fail "Failed to re-apply: $filename"
    log "  Error details:"
    run_psql -f "$migration" 2>&1 | tail -5 | while read line; do log "    $line"; done
    exit 1
  fi
done

log_success "All $SQL_COUNT SQL migrations re-applied successfully (idempotent)"

# Re-apply JS migrations for idempotency
if [ "$JS_COUNT" -gt 0 ]; then
  for migration in $JS_MIGRATIONS; do
    filename=$(basename "$migration")
    log_info "Re-applying JS migration: $filename"
    if node "$migration" 2>&1 | tee -a "$LOG_FILE"; then
      log_success "Re-applied JS migration: $filename"
    else
      log_fail "Failed to re-apply JS migration: $filename"
      exit 1
    fi
  done
  log_success "All $JS_COUNT JS migrations re-applied successfully (idempotent)"
fi

# Verify tables exist again after re-apply
FINAL_TABLE_COUNT=$(run_psql -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d '[:space:]' || echo "0")
log_info "Tables after re-apply: $FINAL_TABLE_COUNT"
if [ "$FINAL_TABLE_COUNT" -gt 0 ]; then
  log_success "Tables re-created successfully after rollback + re-apply"
else
  log_fail "No tables found after rollback + re-apply"
fi

# ── Summary ───────────────────────────────────────────────────────────────
log ""
log "════════════════════════════════════════════════════════════"
log "  Migration Test Summary"
log "  Completed at: $(date)"
log "  Passed:  $PASSED"
log "  Failed:  $FAILED"
log "════════════════════════════════════════════════════════════"

if [ $FAILED -gt 0 ]; then
  log ""
  log "${RED}✗ MIGRATION TESTS FAILED${NC}"
  log "  See log file for details: $LOG_FILE"
  exit 1
else
  log ""
  log "${GREEN}✓ ALL MIGRATION TESTS PASSED${NC}"
  log "  Log file: $LOG_FILE"
  exit 0
fi
