ALTER TABLE managed_process_start_reservations ADD COLUMN expires_at TEXT;
ALTER TABLE managed_process_start_reservations ADD COLUMN replace_process_id TEXT;

UPDATE managed_process_start_reservations
SET expires_at = created_at
WHERE expires_at IS NULL;

CREATE INDEX idx_managed_process_reservation_expiry
  ON managed_process_start_reservations(expires_at);
